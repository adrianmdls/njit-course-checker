import base64
import json
import re
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup


def encode(value):
    return base64.b64encode(str(value).encode()).decode()


def get_sections(subject, term):
    """Return Banner JSON containing section tables for a subject and term."""
    encoded_subject = quote(encode(subject), safe="")
    encoded_term = quote(encode(term), safe="")

    url = (
        "https://generalssb-prod.ec.njit.edu"
        "/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections"
        f"?MjA%3Dc3ViamVjdA%3D%3D=Nzk%3D{encoded_subject}"
        f"&NTY%3DdGVybQ%3D%3D=NzA%3D{encoded_term}"
        "&Njg%3Db2Zmc2V0=MzY%3DMA%3D%3D"
        "&NzI%3DbWF4=NzI%3DOTk5OQ%3D%3D"
        "&OQ%3D%3DYXR0cg%3D%3D=MzQ%3D"
        "&encoded=true"
    )

    try:
        response = requests.get(url, timeout=(5, 30), allow_redirects=False)
        response.raise_for_status()
    except requests.RequestException:
        raise requests.RequestException("Banner request failed; no snapshot submitted.") from None
    if response.status_code != 200:
        raise ValueError("Unexpected Banner HTTP status; no snapshot submitted.")
    try:
        return response.json()
    except ValueError:
        raise ValueError("Invalid Banner JSON; no snapshot submitted.") from None


class BannerValidationError(ValueError):
    """Fixed diagnostics only: never include upstream HTML or field values."""

    def __init__(self, field, reason, row_index=None):
        self.validation = {"field": field, "row_index": row_index, "reason": reason}
        super().__init__(json.dumps({"event": "banner_validation_failed", **self.validation}))


def parse_section(sections, crn):
    """Use the same strict snapshot parser for individual section lookups."""
    for section in parse_all_sections(sections):
        if section["crn"] == str(crn):
            return {key: value for key, value in section.items() if key not in ("course", "title")}
    raise ValueError("Requested CRN was not found in the retrieved sections")


def parse_all_sections(data):
    """Parse a complete list envelope; [] is the explicit zero-section form.

    Nonempty envelopes require course headings, matching tables and data rows.
    Unknown empty-result markup is rejected until its shape has been verified.
    """
    if not isinstance(data, list):
        raise BannerValidationError("response", "invalid_envelope")
    results = []
    for item in data:
        if not isinstance(item, dict) or not isinstance(item.get("SECTIONS_TABLE"), str):
            raise BannerValidationError("SECTIONS_TABLE", "invalid_envelope")
        markup = item["SECTIONS_TABLE"]
        # BeautifulSoup repairs truncated HTML. Require explicit paired structural
        # tags so that a partial HTTP body cannot become a complete snapshot.
        for tag in ("h4", "table", "tr", "td", "th"):
            if len(re.findall(r"<" + tag + r"\b[^>]*>", markup, re.I)) != len(re.findall(r"</" + tag + r"\s*>", markup, re.I)):
                raise BannerValidationError("SECTIONS_TABLE", "incomplete_markup")
        soup = BeautifulSoup(markup, "html.parser")
        if soup.find(["html", "body", "script", "form"]) is not None:
            raise BannerValidationError("SECTIONS_TABLE", "unexpected_document")
        headings = soup.select("h4[id]")
        tables = soup.select("table.sections-table")
        if (not headings or len(headings) != len(tables)
                or len(soup.find_all("h4")) != len(headings)
                or len(soup.find_all("table")) != len(tables)):
            raise BannerValidationError("SECTIONS_TABLE", "missing_course_table")
        for row in soup.find_all("tr"):
            if row.find_parent("table") not in tables:
                raise BannerValidationError("row", "unmatched_section_row")
        for cell in soup.find_all(["td", "th"]):
            if cell.find_parent("tr") is None:
                raise BannerValidationError("row", "unmatched_section_cell")
        used_tables = set()
        for heading in headings:
            course = " ".join(heading["id"].split())
            if not re.fullmatch(r"[A-Z][A-Z0-9]{0,9} [0-9][A-Z0-9]{0,19}", course):
                raise BannerValidationError("course", "invalid_course", len(results))
            title = heading.get_text(" ", strip=True)
            stored_title = title[len(course) + 3:] if title.startswith(course + " - ") else title
            if not stored_title.strip() or len(stored_title) > 255:
                raise BannerValidationError("title", "invalid_title", len(results))
            table = heading.find_next_sibling()
            if table is None or table.name != "table" or "sections-table" not in table.get("class", []):
                raise BannerValidationError("SECTIONS_TABLE", "missing_sections_table")
            if id(table) in used_tables:
                raise BannerValidationError("SECTIONS_TABLE", "duplicate_table")
            used_tables.add(id(table))
            before = len(results)
            for row in table.select("tr"):
                index = len(results)
                cells = row.find_all(["td", "th"], recursive=False)
                if cells and all(cell.name == "th" for cell in cells):
                    if len(cells) != 13 or any(cell.get("colspan", "1") != "1" for cell in cells):
                        raise BannerValidationError("row", "invalid_columns", index)
                    continue
                if len(cells) != 13 or any(cell.name != "td" or cell.get("colspan", "1") != "1"
                                           or cell.find("table") is not None for cell in cells):
                    raise BannerValidationError("row", "invalid_columns", index)
                cells = [cell.get_text(" ", strip=True) for cell in cells]
                if not re.fullmatch(r"[0-9]{5}", cells[1]):
                    raise BannerValidationError("crn", "invalid_crn", index)
                if not cells[0] or len(cells[0]) > 20:
                    raise BannerValidationError("section", "invalid_section", index)
                status = cells[5].upper()
                if status not in ("OPEN", "CLOSED", "CANCELLED"):
                    raise BannerValidationError("status", "invalid_status", index)
                for column, field in ((6, "max_enrollment"), (7, "current_enrollment")):
                    if not re.fullmatch(r"[0-9]{1,10}", cells[column]) or int(cells[column]) > 4294967295:
                        raise BannerValidationError(field, "invalid_enrollment", index)
                maximum, enrolled = int(cells[6]), int(cells[7])
                results.append({
                    "course": course, "title": title, "crn": cells[1], "section": cells[0],
                    "days": cells[2], "meeting_time": cells[3], "location": cells[4],
                    "status": status, "max_enrollment": maximum, "current_enrollment": enrolled,
                    "seats_remaining": maximum - enrolled, "instructor": cells[8],
                    "delivery_mode": cells[9], "credits": cells[10], "info": cells[11],
                    "comments": cells[12],
                })
            if len(results) == before:
                raise BannerValidationError("SECTIONS_TABLE", "missing_section_rows")
        if used_tables != {id(table) for table in tables}:
            raise BannerValidationError("SECTIONS_TABLE", "unmatched_sections_table")
    return results
