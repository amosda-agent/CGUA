"""
프롬프트 명세에 따른 재무지표 계산 모듈
추출된 재무제표 원시 데이터로부터 지표 A/B/C 전 항목을 산출합니다.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional
import math


def _safe(value) -> Optional[float]:
    """문자열 수치를 float으로 안전 변환. 실패 시 None."""
    if value is None or value == "" or value == "N/A":
        return None
    try:
        return float(str(value).replace(",", "").replace(" ", ""))
    except (ValueError, TypeError):
        return None


def _fmt(value: Optional[float], pct: bool = False, decimals: int = 1) -> str:
    """출력 포맷: 비율은 % 단위, 금액은 천원 단위."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "N/A"
    if pct:
        return f"{round(value, decimals):.{decimals}f}%"
    return f"{round(value, decimals):,.{decimals}f}"


def _div(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """안전한 나눗셈. 분모 0이면 None."""
    if a is None or b is None or b == 0:
        return None
    return a / b


def _growth(curr: Optional[float], prev: Optional[float]) -> Optional[float]:
    """전기 대비 증가율 (%)."""
    if curr is None or prev is None or prev == 0:
        return None
    return (curr - prev) / abs(prev) * 100


def _avg(a: Optional[float], b: Optional[float]) -> Optional[float]:
    """평균잔액. 한쪽이 없으면 존재하는 값으로 대체."""
    if a is None and b is None:
        return None
    if a is None:
        return b
    if b is None:
        return a
    return (a + b) / 2


# ────────────────────────────────────────────────
# 재무 데이터 컨테이너
# ────────────────────────────────────────────────

@dataclass
class FinancialData:
    """단일 회계연도 재무제표 핵심 항목."""
    year: str = ""

    # BS
    current_assets: Optional[float] = None       # 유동자산
    cash_equiv: Optional[float] = None           # 현금성자산
    short_financial: Optional[float] = None      # 단기금융상품
    accounts_receivable: Optional[float] = None  # 매출채권
    inventory: Optional[float] = None            # 재고자산
    non_current_assets: Optional[float] = None   # 비유동자산
    tangible_assets: Optional[float] = None      # 유형자산
    total_assets: Optional[float] = None         # 자산총계
    current_liabilities: Optional[float] = None  # 유동부채
    accounts_payable: Optional[float] = None     # 매입채무
    short_borrowings: Optional[float] = None     # 단기차입금
    current_portion_ltd: Optional[float] = None  # 유동성장기부채
    non_current_liabilities: Optional[float] = None  # 비유동부채
    long_borrowings: Optional[float] = None      # 장기차입금
    bonds: Optional[float] = None               # 사채
    lease_liabilities: Optional[float] = None   # 리스부채
    total_borrowings: Optional[float] = None    # 총차입금
    total_liabilities: Optional[float] = None   # 부채총계
    capital_stock: Optional[float] = None       # 자본금
    capital_surplus: Optional[float] = None     # 자본잉여금
    retained_earnings: Optional[float] = None   # 이익잉여금
    other_comprehensive: Optional[float] = None # 기타포괄손익누계액
    other_equity: Optional[float] = None        # 기타자본구성요소
    controlling_interest: Optional[float] = None# 지배기업소유주지분
    non_controlling: Optional[float] = None     # 비지배지분
    total_equity: Optional[float] = None        # 자본총계

    # IS
    revenue: Optional[float] = None             # 매출액
    cogs: Optional[float] = None                # 매출원가
    gross_profit: Optional[float] = None        # 매출총이익
    sga: Optional[float] = None                 # 판관비
    operating_income: Optional[float] = None    # 영업이익
    finance_income: Optional[float] = None      # 금융수익
    other_income: Optional[float] = None        # 기타수익
    finance_cost: Optional[float] = None        # 금융비용
    interest_expense: Optional[float] = None    # 이자비용
    other_expense: Optional[float] = None       # 기타비용
    ebt: Optional[float] = None                 # 법인세비용차감전순이익
    tax_expense: Optional[float] = None         # 법인세비용
    net_income: Optional[float] = None          # 당기순이익
    depreciation: Optional[float] = None        # 감가상각비
    amortization: Optional[float] = None        # 무형자산상각비

    # CF
    ocf: Optional[float] = None                 # 영업활동현금흐름
    investing_cf: Optional[float] = None        # 투자활동현금흐름
    capex: Optional[float] = None               # 유형자산취득
    financing_cf: Optional[float] = None        # 재무활동현금흐름
    beginning_cash: Optional[float] = None      # 기초현금
    cash_increase: Optional[float] = None       # 현금의증가
    ending_cash: Optional[float] = None         # 기말현금

    # SCE
    beginning_equity: Optional[float] = None    # 기초자본
    dividends_paid: Optional[float] = None      # 배당금유출
    other_equity_tx: Optional[float] = None     # 기타자본거래
    ending_equity_sce: Optional[float] = None   # 기말자본(SCE)

    # 계산값
    @property
    def ebitda(self) -> Optional[float]:
        if self.operating_income is None:
            return None
        dep = self.depreciation or 0
        amor = self.amortization or 0
        return self.operating_income + dep + amor

    @property
    def fcf(self) -> Optional[float]:
        if self.ocf is None or self.capex is None:
            return None
        return self.ocf - abs(self.capex)

    @property
    def computed_total_borrowings(self) -> Optional[float]:
        items = [self.short_borrowings, self.current_portion_ltd,
                 self.long_borrowings, self.bonds, self.lease_liabilities]
        known = [x for x in items if x is not None]
        return sum(known) if known else self.total_borrowings


# ────────────────────────────────────────────────
# 지표 계산기
# ────────────────────────────────────────────────

class IndicatorCalculator:
    """
    유형 A (신청기업), 유형 B (모회사), 유형 C (종속/형제)
    지표를 프롬프트 고정 순번에 따라 계산합니다.
    """

    def __init__(self, periods: list[FinancialData]):
        """periods: [N-2, N-1, N] 순서의 FinancialData 리스트."""
        self.periods = periods

    def _get(self, idx: int) -> Optional[FinancialData]:
        return self.periods[idx] if 0 <= idx < len(self.periods) else None

    # ── 공통 단일연도 지표 ──────────────────────────────────────

    def _indicators_single(self, cur: FinancialData, prev: Optional[FinancialData]) -> dict:
        """한 연도의 지표 딕셔너리를 반환합니다."""
        ind = {}

        # 성장성
        ind["매출액증가율"] = (_growth(cur.revenue, prev.revenue) if prev else None, True)
        ind["영업이익증가율"] = (_growth(cur.operating_income, prev.operating_income) if prev else None, True)
        ind["당기순이익증가율"] = (_growth(cur.net_income, prev.net_income) if prev else None, True)
        ind["총자산증가율"] = (_growth(cur.total_assets, prev.total_assets) if prev else None, True)
        ind["자기자본증가율"] = (_growth(cur.total_equity, prev.total_equity) if prev else None, True)

        # 수익성
        ind["영업이익률"] = (_div(cur.operating_income, cur.revenue) * 100 if _div(cur.operating_income, cur.revenue) is not None else None, True)
        ind["당기순이익률"] = (_div(cur.net_income, cur.revenue) * 100 if _div(cur.net_income, cur.revenue) is not None else None, True)
        ind["매출총이익률"] = (_div(cur.gross_profit, cur.revenue) * 100 if _div(cur.gross_profit, cur.revenue) is not None else None, True)
        ind["매출원가율"] = (_div(cur.cogs, cur.revenue) * 100 if _div(cur.cogs, cur.revenue) is not None else None, True)
        ind["판관비율"] = (_div(cur.sga, cur.revenue) * 100 if _div(cur.sga, cur.revenue) is not None else None, True)

        prev_ta = prev.total_assets if prev else None
        prev_eq = prev.total_equity if prev else None
        ind["ROA"] = (_div(cur.net_income, _avg(cur.total_assets, prev_ta)) * 100 if _div(cur.net_income, _avg(cur.total_assets, prev_ta)) is not None else None, True)
        ind["ROE"] = (_div(cur.net_income, _avg(cur.total_equity, prev_eq)) * 100 if _div(cur.net_income, _avg(cur.total_equity, prev_eq)) is not None else None, True)
        ind["EBITDA"] = (cur.ebitda, False)

        # 안정성
        ind["유동비율"] = (_div(cur.current_assets, cur.current_liabilities) * 100 if _div(cur.current_assets, cur.current_liabilities) is not None else None, True)
        ind["부채비율"] = (_div(cur.total_liabilities, cur.total_equity) * 100 if _div(cur.total_liabilities, cur.total_equity) is not None else None, True)

        # 이자보상배수
        if cur.operating_income is not None and cur.interest_expense is not None:
            if cur.interest_expense == 0:
                ind["이자보상배수"] = (None, False)
            elif cur.operating_income < 0:
                ind["이자보상배수"] = ("음수(-)", False)
            else:
                ind["이자보상배수"] = (cur.operating_income / cur.interest_expense, False)
        else:
            ind["이자보상배수"] = (None, False)

        tb = cur.computed_total_borrowings
        ind["차입금의존도"] = (_div(tb, cur.total_assets) * 100 if _div(tb, cur.total_assets) is not None else None, True)
        ind["자기자본비율"] = (_div(cur.total_equity, cur.total_assets) * 100 if _div(cur.total_equity, cur.total_assets) is not None else None, True)
        ind["총차입금/자기자본"] = (_div(tb, cur.total_equity) * 100 if _div(tb, cur.total_equity) is not None else None, True)

        # 활동성
        prev_ar = prev.accounts_receivable if prev else None
        prev_inv = prev.inventory if prev else None
        prev_ap = prev.accounts_payable if prev else None
        prev_ta2 = prev.total_assets if prev else None
        ind["매출채권회전율"] = (_div(cur.revenue, _avg(cur.accounts_receivable, prev_ar)), False)
        ind["재고자산회전율"] = (_div(cur.cogs, _avg(cur.inventory, prev_inv)), False)
        ind["매입채무회전율"] = (_div(cur.cogs, _avg(cur.accounts_payable, prev_ap)), False)
        ind["총자산회전율"] = (_div(cur.revenue, _avg(cur.total_assets, prev_ta2)), False)

        # 현금흐름
        ind["영업활동현금흐름(OCF)"] = (cur.ocf, False)
        ind["FCF (영업CF − CAPEX)"] = (cur.fcf, False)
        ind["CAPEX"] = (cur.capex, False)

        return ind

    # ── 유형 A 전체 테이블 ──────────────────────────────────────

    TYPE_A_ORDER = [
        ("01", "성장", "매출액증가율"),
        ("02", "성장", "영업이익증가율"),
        ("03", "성장", "당기순이익증가율"),
        ("04", "성장", "총자산증가율"),
        ("05", "성장", "자기자본증가율"),
        ("06", "수익", "영업이익률"),
        ("07", "수익", "당기순이익률"),
        ("08", "수익", "매출총이익률"),
        ("09", "수익", "매출원가율"),
        ("10", "수익", "판관비율"),
        ("11", "수익", "ROA"),
        ("12", "수익", "ROE"),
        ("13", "수익", "EBITDA"),
        ("14", "안정", "유동비율"),
        ("15", "안정", "부채비율"),
        ("16", "안정", "이자보상배수"),
        ("17", "안정", "차입금의존도"),
        ("18", "안정", "자기자본비율"),
        ("19", "안정", "총차입금/자기자본"),
        ("20", "활동", "매출채권회전율"),
        ("21", "활동", "재고자산회전율"),
        ("22", "활동", "매입채무회전율"),
        ("23", "활동", "총자산회전율"),
        ("24", "현금", "영업활동현금흐름(OCF)"),
        ("25", "현금", "FCF (영업CF − CAPEX)"),
        ("26", "현금", "CAPEX"),
    ]

    def calc_type_a(self) -> list[dict]:
        """유형 A 지표를 계산하여 행 리스트로 반환합니다."""
        all_ind = []
        for i, fd in enumerate(self.periods):
            prev = self.periods[i - 1] if i > 0 else None
            all_ind.append(self._indicators_single(fd, prev))

        rows = []
        for no, category, name in self.TYPE_A_ORDER:
            row = {"No": no, "구분": category, "재무지표": name}
            for i, fd in enumerate(self.periods):
                val, is_pct = all_ind[i].get(name, (None, False))
                if isinstance(val, str):          # "음수(-)" 등 문자 케이스
                    row[fd.year] = val
                elif is_pct:
                    row[fd.year] = _fmt(val, pct=True)
                elif name == "EBITDA" or "현금" in name or "CAPEX" in name:
                    row[fd.year] = _fmt(val, pct=False, decimals=0)  # 천원 정수
                else:
                    row[fd.year] = _fmt(val, pct=False)
            rows.append(row)
        return rows

    TYPE_B_ORDER = [
        ("01", "안정", "부채비율"),
        ("02", "안정", "유동비율"),
        ("03", "안정", "이자보상배수"),
        ("04", "안정", "차입금의존도"),
        ("05", "지원", "이중레버리지비율"),
        ("06", "지원", "자본유동화비율"),
        ("07", "지원", "별도기준 가용현금"),
        ("08", "수익", "영업이익률"),
        ("09", "수익", "EBITDA"),
    ]

    def calc_type_b(self, subsidiary_investment: Optional[float] = None) -> list[dict]:
        """유형 B (모회사) 지표 계산."""
        all_ind = []
        for i, fd in enumerate(self.periods):
            prev = self.periods[i - 1] if i > 0 else None
            all_ind.append(self._indicators_single(fd, prev))

        rows = []
        for no, category, name in self.TYPE_B_ORDER:
            row = {"No": no, "구분": category, "재무지표": name}
            for i, fd in enumerate(self.periods):
                if name == "이중레버리지비율":
                    val = _div(subsidiary_investment, fd.total_equity)
                    row[fd.year] = _fmt(val * 100 if val else None, pct=True) if val else "N/A (투자주식 입력 필요)"
                elif name == "자본유동화비율":
                    # 유동자산 / 자기자본
                    val = _div(fd.current_assets, fd.total_equity)
                    row[fd.year] = _fmt(val * 100 if val else None, pct=True) if val else "N/A"
                elif name == "별도기준 가용현금":
                    val = fd.cash_equiv
                    row[fd.year] = _fmt(val, decimals=0) if val else "N/A"
                else:
                    ind_val, is_pct = all_ind[i].get(name, (None, False))
                    if isinstance(ind_val, str):
                        row[fd.year] = ind_val
                    elif is_pct:
                        row[fd.year] = _fmt(ind_val, pct=True)
                    else:
                        row[fd.year] = _fmt(ind_val, decimals=0)
            rows.append(row)
        return rows

    TYPE_C_ORDER = [
        ("01", "리스크", "영업활동현금흐름(OCF) 부실 여부"),
        ("02", "리스크", "자본잠식율"),
        ("03", "리스크", "당기순손익 적자 여부"),
        ("04", "안정", "부채비율"),
        ("05", "안정", "차입금의존도"),
        ("06", "상호의존", "신청기업 대상 매출비중"),
        ("07", "상호의존", "신청기업 대상 매입비중"),
        ("08", "상호의존", "담보/보증 제공액"),
    ]

    def calc_type_c(
        self,
        related_revenue_from_subject: Optional[float] = None,
        related_purchase_from_subject: Optional[float] = None,
        guarantee_amount: Optional[float] = None,
    ) -> list[dict]:
        """유형 C (종속/형제기업) 지표 계산."""
        all_ind = []
        for i, fd in enumerate(self.periods):
            prev = self.periods[i - 1] if i > 0 else None
            all_ind.append(self._indicators_single(fd, prev))

        rows = []
        for no, category, name in self.TYPE_C_ORDER:
            row = {"No": no, "구분": category, "재무지표": name}
            for i, fd in enumerate(self.periods):
                if name == "영업활동현금흐름(OCF) 부실 여부":
                    ocf = fd.ocf
                    if ocf is None:
                        row[fd.year] = "N/A"
                    elif ocf < 0:
                        row[fd.year] = f"부실 ({_fmt(ocf, decimals=0)}천원)"
                    else:
                        row[fd.year] = f"정상 ({_fmt(ocf, decimals=0)}천원)"
                elif name == "자본잠식율":
                    if fd.total_equity is None or fd.capital_stock is None:
                        row[fd.year] = "N/A"
                    elif fd.total_equity <= 0:
                        row[fd.year] = "완전자본잠식"
                    elif fd.total_equity < fd.capital_stock:
                        rate = (fd.capital_stock - fd.total_equity) / fd.capital_stock * 100
                        row[fd.year] = f"부분잠식 ({_fmt(rate)}%)"
                    else:
                        row[fd.year] = "해당없음"
                elif name == "당기순손익 적자 여부":
                    ni = fd.net_income
                    row[fd.year] = ("적자" if ni is not None and ni < 0 else "흑자") if ni is not None else "N/A"
                elif name == "신청기업 대상 매출비중":
                    val = _div(related_revenue_from_subject, fd.revenue)
                    row[fd.year] = _fmt(val * 100 if val else None, pct=True) if val else "N/A (거래 내역 입력 필요)"
                elif name == "신청기업 대상 매입비중":
                    val = _div(related_purchase_from_subject, fd.cogs)
                    row[fd.year] = _fmt(val * 100 if val else None, pct=True) if val else "N/A (거래 내역 입력 필요)"
                elif name == "담보/보증 제공액":
                    row[fd.year] = _fmt(guarantee_amount, decimals=0) if guarantee_amount else "N/A (주석 확인 필요)"
                else:
                    ind_val, is_pct = all_ind[i].get(name, (None, False))
                    if isinstance(ind_val, str):
                        row[fd.year] = ind_val
                    elif is_pct:
                        row[fd.year] = _fmt(ind_val, pct=True)
                    else:
                        row[fd.year] = _fmt(ind_val)
            rows.append(row)
        return rows
