"""
DART Open API 클라이언트
금융감독원 전자공시시스템(DART) API를 통해 재무데이터를 수집합니다.
"""

import requests
import pandas as pd
from typing import Optional


class DartAPI:
    BASE_URL = "https://opendart.fss.or.kr/api"

    def __init__(self, api_key: str):
        self.api_key = api_key
        self.session = requests.Session()

    def _get(self, endpoint: str, params: dict) -> dict:
        params["crtfc_key"] = self.api_key
        resp = self.session.get(f"{self.BASE_URL}/{endpoint}", params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status", "")
        if status not in ("000", "013"):  # 013 = 정상 (no data)
            raise ValueError(f"DART API 오류 [{status}]: {data.get('message', '')}")
        return data

    # ── 기업 검색 ──────────────────────────────────────────────
    def search_company(self, corp_name: str) -> list[dict]:
        """회사명으로 corp_code 목록을 검색합니다."""
        data = self._get("company.json", {"corp_name": corp_name})
        return data.get("list", [data]) if "list" in data else [data]

    def get_corp_code(self, ticker: str) -> Optional[str]:
        """
        종목코드(ticker)로 DART corp_code(고유번호)를 조회합니다.
        전체 기업 목록 ZIP 파일을 파싱합니다.
        """
        import zipfile, io, xml.etree.ElementTree as ET

        url = f"{self.BASE_URL}/corpCode.xml"
        resp = self.session.get(url, params={"crtfc_key": self.api_key}, timeout=30)
        resp.raise_for_status()

        with zipfile.ZipFile(io.BytesIO(resp.content)) as z:
            xml_data = z.read(z.namelist()[0])

        root = ET.fromstring(xml_data)
        for item in root.findall("list"):
            stock_code = item.findtext("stock_code", "").strip()
            if stock_code == ticker.strip():
                return item.findtext("corp_code", "").strip()
        return None

    # ── 재무제표 조회 ───────────────────────────────────────────
    def get_financial_statements(
        self,
        corp_code: str,
        bsns_year: str,
        reprt_code: str = "11011",  # 11011=사업보고서, 11012=반기, 11013=1분기, 11014=3분기
        fs_div: str = "OFS",        # OFS=별도, CFS=연결
    ) -> list[dict]:
        """단일회사 전체 재무제표를 조회합니다."""
        data = self._get(
            "fnlttSinglAcntAll.json",
            {
                "corp_code": corp_code,
                "bsns_year": bsns_year,
                "reprt_code": reprt_code,
                "fs_div": fs_div,
            },
        )
        return data.get("list", [])

    def get_xbrl_financial(
        self,
        corp_code: str,
        bsns_year: str,
        reprt_code: str = "11011",
        fs_div: str = "OFS",
    ) -> list[dict]:
        """XBRL 표준계정과목 재무제표를 조회합니다 (계정명 표준화에 유리)."""
        data = self._get(
            "fnlttXbrlAcnt.json",
            {
                "corp_code": corp_code,
                "bsns_year": bsns_year,
                "reprt_code": reprt_code,
                "fs_div": fs_div,
            },
        )
        return data.get("list", [])
