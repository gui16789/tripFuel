#!/usr/bin/env python3
"""POC: fit inferred trip drafts to a fuel invoice target.

This script is intentionally a reconstruction aid. It generates draft rows that
must be reviewed against real business activity before they are used anywhere
outside internal reconciliation.
"""

from __future__ import annotations

import argparse
import csv
import math
import json
import os
import random
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import urlopen

from generate_vehicle_usage import DEFAULT_CITY, DEFAULT_FUEL_RATE, DEFAULT_ORIGIN, read_fuel_prices


AMAP_BASE = "https://restapi.amap.com/v3"
DEFAULT_PRICE_PATH = Path("fuel_prices_changchun_92.csv")
DEFAULT_OUTPUT = Path("goal_reconstruction_poc.csv")
DEFAULT_FUEL_OUTPUT = Path("goal_reconstruction_fuel_details_poc.csv")
DEFAULT_JSON_OUTPUT = Path("goal_reconstruction_poc.json")
DEFAULT_CACHE = Path(".goal_reconstruction_cache.json")
DEFAULT_KEYWORDS = [
    "工业园",
    "产业园",
    "科技园",
    "创业园",
    "物流园",
    "企业园区",
    "企业服务中心",
    "开发区管委会",
    "经济开发区",
    "高新技术产业开发区",
    "汽车产业园",
    "装备制造产业园",
    "生物医药产业园",
    "食品产业园",
    "光电信息产业园",
    "智能制造产业园",
    "中小企业服务中心",
    "政务服务中心",
    "税务局",
]


@dataclass(frozen=True)
class Candidate:
    name: str
    address: str
    city: str
    district: str
    type: str
    location: str
    distance_km: int
    duration_min: float


@dataclass(frozen=True)
class DraftTrip:
    date: datetime
    destination: str
    poi_name: str
    address: str
    city: str
    district: str
    distance_km: int
    fuel_price: float
    liters: float
    amount: float


@dataclass(frozen=True)
class FuelDetail:
    date: datetime
    vehicle: str
    driver: str
    amount: float
    liters: float
    average_price: float


class AmapPocClient:
    def __init__(
        self,
        key: str,
        city: str,
        cache_path: Path,
        sleep_seconds: float = 0.12,
        request_timeout: float = 10.0,
    ) -> None:
        self.key = key
        self.city = city
        self.cache_path = cache_path
        self.sleep_seconds = sleep_seconds
        self.request_timeout = request_timeout
        self.cache: dict[str, Any] = {}
        if cache_path.exists():
            self.cache = json.loads(cache_path.read_text(encoding="utf-8"))

    def save(self) -> None:
        self.cache_path.write_text(json.dumps(self.cache, ensure_ascii=False, indent=2), encoding="utf-8")

    def get_json(self, path: str, params: dict[str, Any]) -> dict[str, Any]:
        params = {"key": self.key, "output": "JSON", **params}
        url = f"{AMAP_BASE}/{path}?{urlencode(params)}"
        with urlopen(url, timeout=self.request_timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        if str(data.get("status")) != "1":
            raise RuntimeError(f"AMap request failed: {data.get('info') or data}")
        time.sleep(self.sleep_seconds)
        return data

    def geocode(self, address: str) -> str:
        cache_key = f"geocode::{self.city}::{address}"
        if cache_key not in self.cache:
            data = self.get_json("geocode/geo", {"address": address, "city": self.city})
            geocodes = data.get("geocodes") or []
            if not geocodes or not geocodes[0].get("location"):
                raise RuntimeError(f"AMap cannot geocode address: {address}")
            self.cache[cache_key] = geocodes[0]["location"]
        return str(self.cache[cache_key])

    def search_pois(self, keyword: str, page_size: int) -> list[dict[str, Any]]:
        cache_key = f"pois::{self.city}::{keyword}::{page_size}"
        if cache_key not in self.cache:
            data = self.get_json(
                "place/text",
                {
                    "keywords": keyword,
                    "city": self.city,
                    "citylimit": "true",
                    "offset": str(page_size),
                    "page": "1",
                    "extensions": "base",
                },
            )
            self.cache[cache_key] = data.get("pois") or []
        return list(self.cache[cache_key])

    def driving_distance(self, origin_location: str, destination_location: str) -> tuple[int, float]:
        cache_key = f"roundtrip::{origin_location}::{destination_location}"
        if cache_key not in self.cache:
            outbound = self.get_json(
                "direction/driving",
                {
                    "origin": origin_location,
                    "destination": destination_location,
                    "strategy": "0",
                    "extensions": "base",
                },
            )
            inbound = self.get_json(
                "direction/driving",
                {
                    "origin": destination_location,
                    "destination": origin_location,
                    "strategy": "0",
                    "extensions": "base",
                },
            )
            outbound_path = ((outbound.get("route") or {}).get("paths") or [])[0]
            inbound_path = ((inbound.get("route") or {}).get("paths") or [])[0]
            distance_m = int(float(outbound_path["distance"])) + int(float(inbound_path["distance"]))
            duration_s = int(float(outbound_path.get("duration") or 0)) + int(float(inbound_path.get("duration") or 0))
            self.cache[cache_key] = {"distance_m": distance_m, "duration_s": duration_s}
        item = self.cache[cache_key]
        return int(item["distance_m"]), round(int(item.get("duration_s") or 0) / 60, 1)


def parse_date(raw: str) -> datetime:
    return datetime.strptime(raw, "%Y-%m-%d")


def parse_keywords(raw: str) -> list[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def workdays(start: datetime, end: datetime, skip_weekends: bool) -> list[datetime]:
    days: list[datetime] = []
    cursor = start
    while cursor <= end:
        if not skip_weekends or cursor.weekday() < 5:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def order_days_by_month(days: list[datetime], seed: int) -> list[datetime]:
    rng = random.Random(seed)
    months: dict[str, list[datetime]] = {}
    for day in days:
        months.setdefault(day.strftime("%Y-%m"), []).append(day)
    for month_days in months.values():
        rng.shuffle(month_days)

    ordered: list[datetime] = []
    month_keys = sorted(months)
    while any(months.values()):
        for key in month_keys:
            if months[key]:
                ordered.append(months[key].pop())
    return ordered


def price_for_date(prices: list[tuple[datetime, float]], day: datetime) -> float:
    applicable = [price for effective_date, price in prices if effective_date <= day]
    if not applicable:
        raise RuntimeError(f"No fuel price found on or before {day:%Y-%m-%d}.")
    return applicable[-1]


def destination_key(value: str) -> str:
    return "".join(value.split()).lower()


def collect_candidates(
    client: AmapPocClient,
    origin: str,
    keywords: list[str],
    per_keyword: int,
    min_km: int,
    max_km: int,
    allowed_city: str,
    max_candidates: int | None = None,
    max_route_checks: int | None = None,
    deadline_monotonic: float | None = None,
) -> list[Candidate]:
    origin_location = client.geocode(origin)
    by_location: dict[str, Candidate] = {}
    route_checks = 0

    def sorted_candidates() -> list[Candidate]:
        return sorted(by_location.values(), key=lambda item: item.distance_km)

    def should_stop() -> bool:
        if max_candidates is not None and len(by_location) >= max_candidates:
            return True
        if max_route_checks is not None and route_checks >= max_route_checks:
            return True
        return deadline_monotonic is not None and time.monotonic() >= deadline_monotonic

    for keyword in keywords:
        if should_stop():
            break
        for poi in client.search_pois(keyword, per_keyword):
            if should_stop():
                break
            location = poi.get("location")
            if not location or location in by_location:
                continue
            city = str(poi.get("cityname") or "")
            if allowed_city and city != allowed_city:
                continue
            try:
                route_checks += 1
                distance_m, duration_min = client.driving_distance(origin_location, str(location))
            except Exception:
                continue
            distance_km = round(distance_m / 1000)
            if not min_km <= distance_km <= max_km:
                continue
            name = str(poi.get("name") or keyword)
            address = poi.get("address") if isinstance(poi.get("address"), str) else ""
            by_location[str(location)] = Candidate(
                name=name,
                address=address,
                city=city,
                district=str(poi.get("adname") or ""),
                type=str(poi.get("type") or ""),
                location=str(location),
                distance_km=distance_km,
                duration_min=duration_min,
            )
    return sorted_candidates()


def build_drafts(
    candidates: list[Candidate],
    days: list[datetime],
    prices: list[tuple[datetime, float]],
    target_amount: float,
    fuel_rate: float,
    max_trips_per_day: int,
    amount_tolerance: float,
    recent_cooldown: int,
    max_same_destination: int,
    seed: int,
) -> list[DraftTrip]:
    rng = random.Random(seed)
    pool = [item for item in candidates if item.distance_km > 0]
    if not pool:
        raise RuntimeError("No route candidates are available after filtering.")

    drafts: list[DraftTrip] = []
    total = 0.0
    recent_locations: list[str] = []
    destination_counts: dict[str, int] = {}
    ordered_days = order_days_by_month(days, seed)

    for day in ordered_days:
        price = price_for_date(prices, day)
        trips_today = rng.randint(1, max_trips_per_day)
        for _ in range(trips_today):
            remaining = target_amount - total
            if remaining <= amount_tolerance:
                return sorted(drafts, key=lambda item: item.date)

            # Pick the route that moves closest to the goal, with a small random
            # band so the output is not a monotonous list of identical distances.
            eligible = [
                candidate
                for candidate in pool
                if candidate.location not in recent_locations
                and destination_counts.get(destination_key(candidate.name), 0) < max_same_destination
            ]
            if not eligible:
                eligible = [
                    candidate
                    for candidate in pool
                    if destination_counts.get(destination_key(candidate.name), 0) < max_same_destination
                ]
            if not eligible:
                eligible = [candidate for candidate in pool if candidate.location not in recent_locations]
            if not eligible:
                eligible = pool

            ranked = sorted(
                (
                    (
                        abs(remaining - candidate.distance_km * fuel_rate * price)
                        + destination_counts.get(destination_key(candidate.name), 0) * 35,
                        rng.random(),
                        candidate,
                    )
                    for candidate in eligible
                ),
                key=lambda item: (item[0], item[1]),
            )
            choice_index = 0 if remaining < 220 else rng.randrange(0, min(6, len(ranked)))
            candidate = ranked[choice_index][2]
            amount = candidate.distance_km * fuel_rate * price
            drafts.append(
                DraftTrip(
                    date=day,
                    destination=candidate.name,
                    poi_name=candidate.name,
                    address=candidate.address,
                    city=candidate.city,
                    district=candidate.district,
                    distance_km=candidate.distance_km,
                    fuel_price=price,
                    liters=candidate.distance_km * fuel_rate,
                    amount=amount,
                )
            )
            total += amount
            key = destination_key(candidate.name)
            destination_counts[key] = destination_counts.get(key, 0) + 1
            recent_locations.append(candidate.location)
            if len(recent_locations) > recent_cooldown:
                recent_locations.pop(0)
            if total >= target_amount - amount_tolerance:
                return sorted(drafts, key=lambda item: item.date)

    return sorted(drafts, key=lambda item: item.date)


def split_refuel_amounts(target_amount: float, min_amount: float, max_amount: float, preferred_amount: float) -> list[float]:
    if target_amount <= 0:
        return []
    if min_amount <= 0 or max_amount <= 0 or preferred_amount <= 0 or min_amount > max_amount:
        raise ValueError("Invalid refuel amount limits.")

    min_count = max(1, math.ceil(target_amount / max_amount))
    max_count = max(1, math.floor(target_amount / min_amount))
    if min_count > max_count:
        raise ValueError("目标金额无法拆分到当前单次加油金额上下限内。")

    count = max(min_count, min(max_count, round(target_amount / preferred_amount) or 1))
    amount = round(target_amount / count, 2)
    amounts = [amount for _ in range(count)]
    amounts[-1] = round(target_amount - sum(amounts[:-1]), 2)
    if any(item < min_amount - 0.01 or item > max_amount + 0.01 for item in amounts):
        raise ValueError("目标金额拆分后的单次加油金额超出上下限。")
    return amounts


def choose_refuel_amount(
    remaining_amount: float,
    max_fit_amount: float,
    min_amount: float,
    max_amount: float,
    preferred_amount: float,
) -> float:
    max_allowed = min(remaining_amount, max_fit_amount, max_amount)
    if remaining_amount <= max_allowed + 0.01:
        if remaining_amount < min_amount - 0.01:
            raise ValueError(f"剩余加油金额 {remaining_amount:.2f} 元低于单次下限 {min_amount:.2f} 元。")
        return round(remaining_amount, 2)

    amount = min(preferred_amount, max_allowed)
    remaining_after = remaining_amount - amount
    if 0 < remaining_after < min_amount:
        amount = remaining_amount - min_amount
    if amount < min_amount - 0.01:
        raise ValueError(
            f"当前油箱剩余空间只能容纳 {max_fit_amount:.2f} 元燃油，低于单次下限 {min_amount:.2f} 元。"
        )
    return round(amount, 2)


def build_realistic_fuel_details(
    rows: list[DraftTrip],
    prices: list[tuple[datetime, float]],
    target_amount: float,
    vehicle: str,
    driver: str,
    tank_capacity_liters: float,
    initial_fuel_liters: float,
    minimum_balance_liters: float,
    final_balance_liters: float,
    min_refuel_amount: float,
    max_refuel_amount: float,
    preferred_refuel_amount: float,
    max_refuel_liters: float,
) -> list[FuelDetail]:
    if not rows:
        return []
    if not 0 <= initial_fuel_liters <= tank_capacity_liters:
        raise ValueError("初始油量必须在 0 和油箱容量之间。")
    if not 0 <= minimum_balance_liters < tank_capacity_liters:
        raise ValueError("最低油量必须小于油箱容量。")
    if not minimum_balance_liters <= final_balance_liters <= tank_capacity_liters:
        raise ValueError("期末油量必须不低于最低油量且不超过油箱容量。")

    by_date: dict[datetime, float] = {}
    for row in rows:
        by_date[row.date] = by_date.get(row.date, 0.0) + row.liters

    details: list[FuelDetail] = []
    balance = initial_fuel_liters
    remaining_amount = round(target_amount, 2)

    for current_date in sorted(by_date):
        consumed = by_date[current_date]
        while balance - consumed < minimum_balance_liters and remaining_amount > 0.01:
            price = price_for_date(prices, current_date)
            max_fit_amount = (tank_capacity_liters - balance) * price
            amount = choose_refuel_amount(
                remaining_amount=remaining_amount,
                max_fit_amount=max_fit_amount,
                min_amount=min_refuel_amount,
                max_amount=max_refuel_amount,
                preferred_amount=preferred_refuel_amount,
            )
            liters = amount / price
            capacity_left = tank_capacity_liters - balance
            if liters > max_refuel_liters + 0.01:
                raise ValueError(f"{current_date:%Y-%m-%d} 单次加油 {liters:.2f}L 超过上限 {max_refuel_liters:.2f}L。")
            if liters > capacity_left + 0.01:
                raise ValueError(
                    f"{current_date:%Y-%m-%d} 加油 {liters:.2f}L 后会超过油箱容量，"
                    f"当前余量 {balance:.2f}L，容量 {tank_capacity_liters:.2f}L。"
                )
            details.append(
                FuelDetail(
                    date=current_date,
                    vehicle=vehicle,
                    driver=driver,
                    amount=amount,
                    liters=liters,
                    average_price=price,
                )
            )
            balance += liters
            remaining_amount = round(remaining_amount - amount, 2)

        balance -= consumed
        if balance < minimum_balance_liters - 0.05:
            raise ValueError(
                f"{current_date:%Y-%m-%d} 行驶后燃油余额 {balance:.2f}L，低于最低余量 {minimum_balance_liters:.2f}L。"
            )

    if remaining_amount > 0.01:
        last_date = max(by_date)
        while remaining_amount > 0.01:
            price = price_for_date(prices, last_date)
            max_fit_amount = (tank_capacity_liters - balance) * price
            amount = choose_refuel_amount(
                remaining_amount=remaining_amount,
                max_fit_amount=max_fit_amount,
                min_amount=min_refuel_amount,
                max_amount=max_refuel_amount,
                preferred_amount=preferred_refuel_amount,
            )
            liters = amount / price
            capacity_left = tank_capacity_liters - balance
            if liters > max_refuel_liters + 0.01 or liters > capacity_left + 0.01:
                raise ValueError("剩余目标金额会导致最终油量超过油箱容量，请增加行程消耗或降低目标金额。")
            details.append(
                FuelDetail(
                    date=last_date,
                    vehicle=vehicle,
                    driver=driver,
                    amount=amount,
                    liters=liters,
                    average_price=price,
                )
            )
            balance += liters
            remaining_amount = round(remaining_amount - amount, 2)

    if balance < final_balance_liters - 0.05:
        raise ValueError(
            f"期末燃油余额 {balance:.2f}L，低于目标期末余量 {final_balance_liters:.2f}L。"
        )

    return sorted(details, key=lambda item: item.date)


def build_fuel_details(rows: list[DraftTrip], vehicle: str, driver: str) -> list[FuelDetail]:
    return [
        FuelDetail(
            date=min(bucket, key=lambda item: item.date).date,
            vehicle=vehicle,
            driver=driver,
            amount=sum(row.amount for row in bucket),
            liters=sum(row.liters for row in bucket),
            average_price=sum(row.amount for row in bucket) / sum(row.liters for row in bucket),
        )
        for bucket in (
            [row for row in rows if row.date.strftime("%Y-%m") == month and row.fuel_price == price]
            for month, price in sorted({(row.date.strftime("%Y-%m"), row.fuel_price) for row in rows})
        )
    ]


def build_fuel_balance_report(
    rows: list[DraftTrip],
    fuel_details: list[FuelDetail],
    initial_fuel_liters: float = 0.0,
    minimum_balance_liters: float = 0.0,
    tank_capacity_liters: float | None = None,
) -> dict[str, Any]:
    dates = sorted({row.date for row in rows} | {row.date for row in fuel_details})
    total_refueled = 0.0
    total_consumed = 0.0
    balance = initial_fuel_liters
    min_balance = initial_fuel_liters
    max_balance = initial_fuel_liters
    checkpoints: list[dict[str, Any]] = []

    for current_date in dates:
        refueled = sum(item.liters for item in fuel_details if item.date == current_date)
        consumed = sum(item.liters for item in rows if item.date == current_date)
        total_refueled += refueled
        total_consumed += consumed
        balance += refueled
        max_balance = max(max_balance, balance)
        balance -= consumed
        min_balance = min(min_balance, balance)
        if refueled or consumed:
            checkpoints.append(
                {
                    "date": current_date.strftime("%Y-%m-%d"),
                    "refueled_liters": round(refueled, 2),
                    "consumed_liters": round(consumed, 2),
                    "cumulative_refueled_liters": round(total_refueled, 2),
                    "cumulative_consumed_liters": round(total_consumed, 2),
                    "balance_liters": round(balance, 2),
                }
            )

    return {
        "total_refueled_liters": round(total_refueled, 2),
        "total_consumed_liters": round(total_consumed, 2),
        "initial_fuel_liters": round(initial_fuel_liters, 2),
        "final_balance_liters": round(balance, 2),
        "min_balance_liters": round(min_balance, 2),
        "max_balance_liters": round(max_balance, 2),
        "minimum_required_liters": round(minimum_balance_liters, 2),
        "tank_capacity_liters": round(tank_capacity_liters, 2) if tank_capacity_liters is not None else None,
        "is_valid": min_balance >= minimum_balance_liters - 0.05
        and (tank_capacity_liters is None or max_balance <= tank_capacity_liters + 0.05),
        "checkpoints": checkpoints,
    }


def write_csv(path: Path, rows: list[DraftTrip], origin: str) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "date",
                "origin",
                "destination",
                "distance_km",
                "fuel_price",
                "liters",
                "amount",
                "district",
                "address",
                "city",
                "source",
                "status",
            ],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "date": row.date.strftime("%Y-%m-%d"),
                    "origin": origin,
                    "destination": row.destination,
                    "distance_km": row.distance_km,
                    "fuel_price": f"{row.fuel_price:.2f}",
                    "liters": f"{row.liters:.2f}",
                    "amount": f"{row.amount:.2f}",
                    "district": row.district,
                    "address": row.address,
                    "city": row.city,
                    "source": "goal_reconstruction_poc",
                    "status": "待人工核验",
                }
            )


def write_fuel_csv(path: Path, rows: list[FuelDetail]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["date", "vehicle", "driver", "amount", "liters", "average_price", "source", "status"],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "date": row.date.strftime("%Y-%m-%d"),
                    "vehicle": row.vehicle,
                    "driver": row.driver,
                    "amount": f"{row.amount:.2f}",
                    "liters": f"{row.liters:.2f}",
                    "average_price": f"{row.average_price:.2f}",
                    "source": "goal_reconstruction_poc",
                    "status": "待人工核验",
                }
            )


def write_json(
    path: Path,
    summary: dict[str, Any],
    rows: list[DraftTrip],
    fuel_details: list[FuelDetail],
    origin: str,
) -> None:
    payload = {
        "summary": summary,
        "records": [
            {
                "date": row.date.strftime("%Y-%m-%d"),
                "origin": origin,
                "destination": row.destination,
                "poi_name": row.poi_name,
                "distance_km": row.distance_km,
                "fuel_price": round(row.fuel_price, 2),
                "liters": round(row.liters, 2),
                "amount": round(row.amount, 2),
                "district": row.district,
                "address": row.address,
                "city": row.city,
                "source": "goal_reconstruction_poc",
                "status": "待人工核验",
            }
            for row in rows
        ],
        "fuel_details": [
            {
                "date": row.date.strftime("%Y-%m-%d"),
                "vehicle": row.vehicle,
                "driver": row.driver,
                "amount": round(row.amount, 2),
                "liters": round(row.liters, 2),
                "average_price": round(row.average_price, 2),
                "source": "goal_reconstruction_poc",
                "status": "待人工核验",
            }
            for row in fuel_details
        ],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate goal-fitted reconstruction draft trips with real AMap routes.")
    parser.add_argument("--target-amount", type=float, required=True, help="Invoice tax-included amount to fit.")
    parser.add_argument("--start-date", required=True, help="Start date, YYYY-MM-DD.")
    parser.add_argument("--end-date", required=True, help="End date, YYYY-MM-DD.")
    parser.add_argument("--amap-key", default=os.environ.get("AMAP_KEY", ""), help="AMap Web Service key.")
    parser.add_argument("--city", default=DEFAULT_CITY)
    parser.add_argument("--origin", default=DEFAULT_ORIGIN)
    parser.add_argument("--fuel-rate", type=float, default=DEFAULT_FUEL_RATE)
    parser.add_argument("--fuel-prices", default=str(DEFAULT_PRICE_PATH))
    parser.add_argument("--keywords", default=",".join(DEFAULT_KEYWORDS), help="Comma-separated POI keywords.")
    parser.add_argument("--per-keyword", type=int, default=12)
    parser.add_argument("--min-km", type=int, default=25)
    parser.add_argument("--max-km", type=int, default=260)
    parser.add_argument("--allowed-city", default="长春市", help="Only keep POIs whose AMap cityname matches this value.")
    parser.add_argument("--max-trips-per-day", type=int, default=1)
    parser.add_argument("--amount-tolerance", type=float, default=20.0)
    parser.add_argument("--recent-cooldown", type=int, default=8, help="Avoid destinations used in the last N generated trips.")
    parser.add_argument("--max-same-destination", type=int, default=2, help="Maximum uses of the same POI in one run.")
    parser.add_argument("--vehicle", default="吉AKC166")
    parser.add_argument("--driver", default="李博")
    parser.add_argument("--skip-weekends", action="store_true")
    parser.add_argument("--seed", type=int, default=20260526)
    parser.add_argument("--cache", default=str(DEFAULT_CACHE))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--fuel-output", default=str(DEFAULT_FUEL_OUTPUT))
    parser.add_argument("--json-output", default=str(DEFAULT_JSON_OUTPUT))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.amap_key:
        raise RuntimeError("AMAP_KEY is required for this POC.")
    start = parse_date(args.start_date)
    end = parse_date(args.end_date)
    if end < start:
        raise RuntimeError("--end-date must be on or after --start-date.")

    prices = read_fuel_prices(Path(args.fuel_prices))
    days = workdays(start, end, args.skip_weekends)
    client = AmapPocClient(args.amap_key, args.city, Path(args.cache))
    try:
        candidates = collect_candidates(
            client=client,
            origin=args.origin,
            keywords=parse_keywords(args.keywords),
            per_keyword=args.per_keyword,
            min_km=args.min_km,
            max_km=args.max_km,
            allowed_city=args.allowed_city,
        )
    finally:
        client.save()

    drafts = build_drafts(
        candidates=candidates,
        days=days,
        prices=prices,
        target_amount=args.target_amount,
        fuel_rate=args.fuel_rate,
        max_trips_per_day=args.max_trips_per_day,
        amount_tolerance=args.amount_tolerance,
        recent_cooldown=args.recent_cooldown,
        max_same_destination=args.max_same_destination,
        seed=args.seed,
    )
    fuel_details = build_fuel_details(drafts, args.vehicle, args.driver)

    total_km = sum(row.distance_km for row in drafts)
    total_liters = sum(row.liters for row in drafts)
    total_amount = sum(row.amount for row in drafts)
    fuel_amount = sum(row.amount for row in fuel_details)
    fuel_liters = sum(row.liters for row in fuel_details)
    summary = {
        "target_amount": round(args.target_amount, 2),
        "generated_amount": round(total_amount, 2),
        "difference": round(total_amount - args.target_amount, 2),
        "generated_km": round(total_km, 2),
        "generated_liters": round(total_liters, 2),
        "trip_count": len(drafts),
        "fuel_detail_count": len(fuel_details),
        "fuel_detail_amount": round(fuel_amount, 2),
        "fuel_detail_liters": round(fuel_liters, 2),
        "candidate_count": len(candidates),
        "start_date": args.start_date,
        "end_date": args.end_date,
        "fuel_rate": args.fuel_rate,
        "status": "待人工核验",
    }
    write_csv(Path(args.output), drafts, args.origin)
    write_fuel_csv(Path(args.fuel_output), fuel_details)
    write_json(Path(args.json_output), summary, drafts, fuel_details, args.origin)

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"CSV: {Path(args.output).resolve()}")
    print(f"Fuel CSV: {Path(args.fuel_output).resolve()}")
    print(f"JSON: {Path(args.json_output).resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
