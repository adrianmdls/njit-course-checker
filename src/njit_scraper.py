import base64
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

    response = requests.get(url, timeout=30)
    response.raise_for_status()
    return response.json()


def find_section(sections, subject, course, section):
    """Find an exact course/section, then reuse the CRN parser; None if absent."""
    if not isinstance(sections, list):
        raise ValueError("Expected a list of Banner course tables")

    for item in sections:
        if not isinstance(item, dict) or not isinstance(item.get("SECTIONS_TABLE"), str):
            raise ValueError("Expected a Banner SECTIONS_TABLE string")
        soup = BeautifulSoup(item["SECTIONS_TABLE"], "html.parser")
        for table in soup.select("table.sections-table"):
            heading = table.find_previous("h4")
            if heading is None or not heading.get("id"):
                raise ValueError("Missing Banner course heading")
            if heading["id"].strip().upper() != f"{subject} {course}":
                continue
            for row in table.select("tr"):
                cells = row.find_all("td", recursive=False)
                if not cells or cells[0].get_text(strip=True).upper() != section:
                    continue
                if len(cells) < 2 or not cells[1].get_text(strip=True):
                    raise ValueError("Missing CRN for requested section")
                return parse_section([item], cells[1].get_text(strip=True))
    return None


def parse_section(sections, crn):
    """Extract one CRN's section details from the retrieved Banner tables."""
    crn = str(crn)

    for item in sections:
        soup = BeautifulSoup(item["SECTIONS_TABLE"], "html.parser")

        for row in soup.select("table.sections-table tr"):
            cells = [
                cell.get_text(" ", strip=True)
                for cell in row.find_all("td", recursive=False)
            ]

            if len(cells) < 2 or cells[1] != crn:
                continue

            if len(cells) != 13:
                raise ValueError(
                    f"Unexpected section columns for CRN {crn}"
                )

            status = cells[5].upper()

            if status not in ("OPEN", "CLOSED"):
                raise ValueError(
                    f"Unexpected status for CRN {crn}: {cells[5]}"
                )

            try:
                max_enrollment = int(cells[6])
                current_enrollment = int(cells[7])
            except ValueError as error:
                raise ValueError(
                    f"Invalid enrollment for CRN {crn}"
                ) from error

            return {
                "crn": crn,
                "section": cells[0],
                "days": cells[2],
                "meeting_time": cells[3],
                "location": cells[4],
                "status": status,
                "max_enrollment": max_enrollment,
                "current_enrollment": current_enrollment,
                "seats_remaining": max_enrollment - current_enrollment,
                "instructor": cells[8],
                "delivery_mode": cells[9],
                "credits": cells[10],
                "info": cells[11],
                "comments": cells[12],
            }

    raise ValueError(
        f"CRN {crn} was not found in the retrieved sections"
    )


if __name__ == "__main__":
    sections = get_sections("IT", "202690")
    print("JSON type:", type(sections).__name__)
    print("Response preview:", str(sections)[:2000])
