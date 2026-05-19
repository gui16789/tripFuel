from __future__ import annotations

import csv
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from urllib.parse import urljoin

import pdfplumber
import requests
from bs4 import BeautifulSoup


LIST_URL = "https://jldrc.jl.gov.cn/zl/"
DEFAULT_OUTPUT = Path("fuel_prices_changchun_92.csv")


@dataclass(frozen=True)
class FuelPrice:
    effective_date: str
    province: str
    city: str
    fuel_type: str
    price: float
    source_url: str


def fetch_html(url: str) -> str:
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    response.raise_for_status()
    response.encoding = response.apparent_encoding
    return response.text


def fetch_bytes(url: str) -> bytes:
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    response.raise_for_status()
    return response.content


def extract_92_price_from_pdf(pdf_bytes: bytes) -> float:
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    match = re.search(r"92#乙醇汽油\s+\d+\s+\d+\s+[\d.]+\s+([\d.]+)", text)
    if not match:
        raise ValueError("Cannot find 92#乙醇汽油 price in PDF.")
    return float(match.group(1))


def parse_effective_date(title: str) -> str | None:
    match = re.search(r"（(\d{4})年(\d{1,2})月(\d{1,2})日24时起执行", title)
    if not match:
        return None

    year, month, day = map(int, match.groups())
    # The notice says "24时起执行", so a date-only trip uses the next day.
    effective = datetime(year, month, day) + timedelta(days=1)
    return effective.strftime("%Y-%m-%d")


def scrape_jilin_prices(year_month: str = "2026-04") -> list[FuelPrice]:
    html = fetch_html(LIST_URL)
    soup = BeautifulSoup(html, "html.parser")
    prices: list[FuelPrice] = []

    for link in soup.find_all("a"):
        title = link.get_text(strip=True)
        href = link.get("href") or ""
        if "吉林省成品油最高零售价格表" not in title:
            continue
        effective_date = parse_effective_date(title)
        if not effective_date or not effective_date.startswith(year_month):
            continue

        page_url = urljoin(LIST_URL, href)
        page_html = fetch_html(page_url)
        page_soup = BeautifulSoup(page_html, "html.parser")
        pdf_link = None
        for candidate in page_soup.find_all("a"):
            candidate_href = candidate.get("href") or ""
            if candidate_href.lower().endswith(".pdf"):
                pdf_link = urljoin(page_url, candidate_href)
                break
        if not pdf_link:
            raise ValueError(f"Cannot find PDF link in {page_url}")

        price = extract_92_price_from_pdf(fetch_bytes(pdf_link))
        prices.append(
            FuelPrice(
                effective_date=effective_date,
                province="吉林",
                city="长春",
                fuel_type="92",
                price=price,
                source_url=page_url,
            )
        )

    return sorted(prices, key=lambda item: item.effective_date)


def merge_and_save_prices(prices: list[FuelPrice], output: Path = DEFAULT_OUTPUT) -> list[FuelPrice]:
    rows: dict[tuple[str, str, str, str], FuelPrice] = {}
    if output.exists():
        with output.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            for row in reader:
                if not row.get("effective_date"):
                    continue
                item = FuelPrice(
                    effective_date=row["effective_date"],
                    province=row.get("province") or "吉林",
                    city=row.get("city") or "长春",
                    fuel_type=row.get("fuel_type") or "92",
                    price=float(row["price"]),
                    source_url=row.get("source_url") or "",
                )
                rows[(item.effective_date, item.province, item.city, item.fuel_type)] = item

    for item in prices:
        rows[(item.effective_date, item.province, item.city, item.fuel_type)] = item

    merged = sorted(rows.values(), key=lambda item: item.effective_date)
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["effective_date", "province", "city", "fuel_type", "price", "source_url"],
        )
        writer.writeheader()
        for item in merged:
            writer.writerow(item.__dict__)
    return merged


if __name__ == "__main__":
    merged = merge_and_save_prices(scrape_jilin_prices("2026-04"))
    for item in merged:
        print(item)
