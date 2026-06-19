"""
DART API 응답(fnlttSinglAcntAll) → FinancialData 변환 모듈
계정과목명 유연 매핑 + 단위(원/천원) 자동 처리
"""

from __future__ import annotations
import re
from typing import Optional
from indicators import FinancialData


def _parse_amount(val: str) -> Optional[float]:
    """금액 문자열을 float으로 변환. 괄호→음수, 쉼표 제거."""
    if not val or val.strip() in ("-", "", "N/A"):
        return None
    s = str(val).replace(",", "").replace(" ", "")
    if s.startswith("(") and s.endswith(")"):
        s = "-" + s[1:-1]
    try:
        return float(s)
    except ValueError:
        return None


def _to_thousand(amount: Optional[float], unit_str: str) -> Optional[float]:
    """
    원(KRW) 단위이면 /1000 하여 천원으로 환산.
    단위 문자열에 '원'만 있으면 원 단위, '천원'이 있으면 이미 천원.
    """
    if amount is None:
        return None
    if "천원" in unit_str or "천 원" in unit_str:
        return amount
    if "백만" in unit_str:
        return amount * 1_000        # 백만원 → 천원
    if "억" in unit_str:
        return amount * 100_000      # 억원 → 천원
    # 기본: 원 단위 → 천원
    return amount / 1_000


# ── 계정명 패턴 → FinancialData 필드 매핑 ──────────────────────

_FIELD_MAP: list[tuple[str, str]] = [
    # (정규식 패턴, FinancialData 필드명)
    # BS
    (r"유동자산$", "current_assets"),
    (r"현금(및현금성자산|성자산|등가물)", "cash_equiv"),
    (r"단기금융(상품|자산)", "short_financial"),
    (r"매출채권(및기타채권)?$", "accounts_receivable"),
    (r"재고자산$", "inventory"),
    (r"비유동자산$", "non_current_assets"),
    (r"유형자산$", "tangible_assets"),
    (r"자산총계$", "total_assets"),
    (r"유동부채$", "current_liabilities"),
    (r"매입채무(및기타채무)?$", "accounts_payable"),
    (r"단기차입금$", "short_borrowings"),
    (r"유동성장기(차입금|부채)$", "current_portion_ltd"),
    (r"비유동부채$", "non_current_liabilities"),
    (r"장기차입금$", "long_borrowings"),
    (r"사채$", "bonds"),
    (r"리스부채$", "lease_liabilities"),
    (r"총?차입금$", "total_borrowings"),
    (r"부채총계$", "total_liabilities"),
    (r"자본금$", "capital_stock"),
    (r"자본잉여금$", "capital_surplus"),
    (r"이익잉여금(결손금)?$", "retained_earnings"),
    (r"기타포괄손익누계액$", "other_comprehensive"),
    (r"기타자본(구성요소|항목)$", "other_equity"),
    (r"지배기업(소유주)?지분$", "controlling_interest"),
    (r"비지배지분$", "non_controlling"),
    (r"자본총계$", "total_equity"),

    # IS
    (r"(매출액|영업수익|수익)$", "revenue"),
    (r"(매출원가|영업비용)$", "cogs"),
    (r"매출총이익$", "gross_profit"),
    (r"(판매비와관리비|판관비)$", "sga"),
    (r"영업이익(손실)?$", "operating_income"),
    (r"금융수익$", "finance_income"),
    (r"기타수익$", "other_income"),
    (r"금융비용$", "finance_cost"),
    (r"이자비용$", "interest_expense"),
    (r"기타비용$", "other_expense"),
    (r"법인세비용차감전(순이익|손익)$", "ebt"),
    (r"법인세비용$", "tax_expense"),
    (r"당기순이익(손실)?$", "net_income"),
    (r"감가상각비$", "depreciation"),
    (r"무형자산상각비$", "amortization"),

    # CF
    (r"영업활동(으로인한)?현금흐름", "ocf"),
    (r"투자활동(으로인한)?현금흐름", "investing_cf"),
    (r"유형자산의?취득$", "capex"),
    (r"재무활동(으로인한)?현금흐름", "financing_cf"),
    (r"기초현금(및현금성자산)?$", "beginning_cash"),
    (r"현금(및현금성자산)?의?(순)?증가(감소)?$", "cash_increase"),
    (r"기말현금(및현금성자산)?$", "ending_cash"),

    # SCE
    (r"기초자본$", "beginning_equity"),
    (r"배당금(유출|지급)$", "dividends_paid"),
    (r"기말자본$", "ending_equity_sce"),
]

_COMPILED_MAP = [
    (re.compile(pattern, re.IGNORECASE), field)
    for pattern, field in _FIELD_MAP
]


def _match_field(account_name: str) -> Optional[str]:
    """계정명을 정규식으로 매칭하여 FinancialData 필드를 반환합니다."""
    # 공백·특수문자 정규화
    name = re.sub(r"[\s\(\)\[\]·]", "", account_name)
    for pattern, field in _COMPILED_MAP:
        if pattern.search(name):
            return field
    return None


# ── 메인 파서 ───────────────────────────────────────────────────

def parse_dart_financials(
    raw_items: list[dict],
    target_year: str,
    fs_div: str = "OFS",  # OFS=별도, CFS=연결
) -> FinancialData:
    """
    DART fnlttSinglAcntAll 응답 아이템 리스트를 FinancialData로 변환합니다.
    target_year: "2023" 형태의 사업연도
    """
    fd = FinancialData(year=target_year)

    # 보고서 단위 감지 (첫 항목의 thstrm_amount 주변 컨텍스트에서 추출 시도)
    unit_str = "원"  # 기본값
    for item in raw_items[:5]:
        nm = str(item.get("account_nm", ""))
        if "천원" in nm or "천원" in str(item.get("currency", "")):
            unit_str = "천원"
            break

    for item in raw_items:
        account_nm = item.get("account_nm", "")
        # 당기 금액
        amount_str = item.get("thstrm_amount", "") or item.get("thstrm_add_amount", "")
        amount = _parse_amount(amount_str)
        if amount is None:
            continue

        amount_k = _to_thousand(amount, unit_str)
        field = _match_field(account_nm)
        if field and hasattr(fd, field):
            existing = getattr(fd, field)
            if existing is None:  # 첫 매칭만 반영 (상위 항목 우선)
                setattr(fd, field, amount_k)

    # 파생 계산: 매출총이익, 총차입금 등 없으면 역산
    if fd.gross_profit is None and fd.revenue and fd.cogs:
        fd.gross_profit = fd.revenue - fd.cogs
    if fd.total_borrowings is None:
        fd.total_borrowings = fd.computed_total_borrowings

    return fd


# ── 편의 함수: 3개년 일괄 파싱 ─────────────────────────────────

def build_3year_data(
    dart_api,
    corp_code: str,
    base_year: int,
    fs_div: str = "OFS",
    reprt_code: str = "11011",
) -> list[FinancialData]:
    """
    base_year 기준 최근 3개년 (N-2, N-1, N) FinancialData 리스트를 반환합니다.
    """
    result = []
    for year in [base_year - 2, base_year - 1, base_year]:
        raw = dart_api.get_financial_statements(
            corp_code=corp_code,
            bsns_year=str(year),
            reprt_code=reprt_code,
            fs_div=fs_div,
        )
        fd = parse_dart_financials(raw, str(year), fs_div)
        result.append(fd)
    return result
