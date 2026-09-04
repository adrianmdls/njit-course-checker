# load script: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.adrian.classchecker.plist
'''
launchctl list | grep classcheckerlaunchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.adrian.classchecker.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.adrian.classchecker.plist
'''
# verify process is running: launchctl list | grep classchecker
# check log: tail -f ~/class-checker/checker.log

import requests
from bs4 import BeautifulSoup
from datetime import datetime

ENDPOINTS = [
    # IT Endpoint
    "https://generalssb-prod.ec.njit.edu/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections?MTU%3DdGVybQ%3D%3D=MzQ%3DMjAyNjkw&MjE%3DYXR0cg%3D%3D=NzM%3D&MzA%3Db2Zmc2V0=ODU%3DMA%3D%3D&ODk%3Dc3ViamVjdA%3D%3D=ODU%3DSVQ%3D&OTA%3DbWF4=NDY%3DOTk5OQ%3D%3D&encoded=true",
    # CS Endpoint
    "https://generalssb-prod.ec.njit.edu/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections?MTM%3Db2Zmc2V0=ODk%3DMA%3D%3D&NTE%3DYXR0cg%3D%3D=Mzk%3D&NzE%3DdGVybQ%3D%3D=Nzc%3DMjAyNjkw&NzY%3Dc3ViamVjdA%3D%3D=NzA%3DQ1M%3D&OTA%3DbWF4=NTY%3DOTk5OQ%3D%3D&encoded=true",
    # IS Endpoint
    "https://generalssb-prod.ec.njit.edu/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections?MjU%3Dc3ViamVjdA%3D%3D=MjM%3DSVM%3D&NDU%3Db2Zmc2V0=OQ%3D%3DMA%3D%3D&NDk%3DbWF4=Nw%3D%3DOTk5OQ%3D%3D&NTg%3DdGVybQ%3D%3D=NjU%3DMjAyNjkw&OQ%3D%3DYXR0cg%3D%3D=OTY%3D&encoded=true",
]

TARGETS = {
    "93910": "IS 331-003",
    "91936": "CS 288-005",
    "91921": "CS 288-001",
}

sections = {}

print()
print(f"CHECKED: {datetime.now().strftime('%Y-%m-%d %I:%M:%S %p')}")

for url in ENDPOINTS:
    response = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=10
    )
    response.raise_for_status()

    data = response.json()

    html = ""
    for item in data:
        if "SECTIONS_TABLE" in item:
            html += item["SECTIONS_TABLE"]

    soup = BeautifulSoup(html, "html.parser")

    for row in soup.find_all("tr"):
        cells = row.find_all("td")

        if len(cells) < 8:
            continue

        crn = cells[1].get_text(strip=True)

        try:
            max_seats = int(cells[6].get_text(strip=True))
            enrolled = int(cells[7].get_text(strip=True))
        except ValueError:
            continue

        sections[crn] = {
            "section": cells[0].get_text(strip=True),
            "status": cells[5].get_text(strip=True),
            "max": max_seats,
            "now": enrolled,
        }

for crn, name in TARGETS.items():
    print("=" * 40)
    print(f"{name} (CRN {crn})")

    if crn not in sections:
        print("⚠️ CRN not found in any endpoint.")
        continue

    info = sections[crn]
    available = max(0, info["max"] - info["now"])

    print(f"Enrollment: {info['now']}/{info['max']}")
    print(f"Available: {available}")
    print(f"Status: {info['status']}")

    if available > 0 and info["status"].lower() == "open":
        print("🚨 SEAT AVAILABLE!")
    else:
        print("❌ No seats available.")