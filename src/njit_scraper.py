import base64
from urllib.parse import quote

import requests


def encode(value):
    return base64.b64encode(str(value).encode()).decode()


subject = "IT"
encoded_subject = quote(encode(subject), safe="")

url = (
    "https://generalssb-prod.ec.njit.edu"
    "/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections"
    f"?MjA%3Dc3ViamVjdA%3D%3D=Nzk%3D{encoded_subject}"
    "&NTY%3DdGVybQ%3D%3D=NzA%3DMjAyNjkw"
    "&Njg%3Db2Zmc2V0=MzY%3DMA%3D%3D"
    "&NzI%3DbWF4=NzI%3DOTk5OQ%3D%3D"
    "&OQ%3D%3DYXR0cg%3D%3D=MzQ%3D"
    "&encoded=true"
)

response = requests.get(url, timeout=30)

print("HTTP status:", response.status_code)
print("Content type:", response.headers.get("Content-Type"))

response.raise_for_status()
sections = response.json()

print("JSON type:", type(sections).__name__)
print("Response preview:", str(sections)[:2000])

print("IT:", encode("IT"))
print("CS:", encode("CS"))
print("TERM:", encode("202690"))
print("OFFSET:", encode("0"))
print("MAX:", encode("9999"))
