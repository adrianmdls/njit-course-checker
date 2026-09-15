import base64
from urllib.parse import quote

import requests


def encode(value):
    return base64.b64encode(str(value).encode()).decode()


def get_sections(subject, term):
    """Return Banner JSON containing section tables for a subject and term."""
    encoded_subject = quote(encode(subject), safe="")
    encoded_term = quote(encode(term), safe="")

    # Preserve the numeric prefixes from the verified Banner request.
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


if __name__ == "__main__":
    sections = get_sections("IT", "202690")
    print("JSON type:", type(sections).__name__)
    print("Response preview:", str(sections)[:2000])
