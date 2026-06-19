"""
DART 재무데이터 추출 — Hugging Face Spaces (Gradio) 앱
ticker + 기준연도 입력 → 3개년 재무제표 + 지표 테이블 출력
"""

import os
import gradio as gr
import pandas as pd

from dart_api import DartAPI
from parser import build_3year_data
from indicators import IndicatorCalculator, FinancialData

# ── 환경변수 또는 Spaces Secret에서 API 키 로드 ──────────────────
DART_API_KEY = os.environ.get("DART_API_KEY", "")

# ── BS/IS/CF 원시 재무제표 표 생성 ───────────────────────────────

BS_FIELDS = [
    ("01", "유동자산", "current_assets"),
    ("02", "현금성자산", "cash_equiv"),
    ("03", "단기금융상품", "short_financial"),
    ("04", "매출채권", "accounts_receivable"),
    ("05", "재고자산", "inventory"),
    ("06", "비유동자산", "non_current_assets"),
    ("07", "유형자산", "tangible_assets"),
    ("08", "자산총계", "total_assets"),
    ("09", "유동부채", "current_liabilities"),
    ("10", "매입채무", "accounts_payable"),
    ("11", "단기차입금", "short_borrowings"),
    ("12", "유동성장기부채", "current_portion_ltd"),
    ("13", "비유동부채", "non_current_liabilities"),
    ("14", "장기차입금", "long_borrowings"),
    ("15", "사채", "bonds"),
    ("16", "리스부채", "lease_liabilities"),
    ("17", "총차입금", "total_borrowings"),
    ("18", "부채총계", "total_liabilities"),
    ("19", "자본금", "capital_stock"),
    ("20", "자본잉여금", "capital_surplus"),
    ("21", "이익잉여금", "retained_earnings"),
    ("22", "기타포괄손익누계액", "other_comprehensive"),
    ("23", "기타자본구성요소", "other_equity"),
    ("24", "지배기업소유주지분", "controlling_interest"),
    ("25", "비지배지분", "non_controlling"),
    ("26", "자본총계", "total_equity"),
]

IS_FIELDS = [
    ("27", "매출액", "revenue"),
    ("28", "매출원가", "cogs"),
    ("29", "매출총이익", "gross_profit"),
    ("30", "판관비", "sga"),
    ("31", "영업이익", "operating_income"),
    ("32", "금융수익", "finance_income"),
    ("33", "기타수익", "other_income"),
    ("34", "금융비용", "finance_cost"),
    ("35", "이자비용", "interest_expense"),
    ("36", "기타비용", "other_expense"),
    ("37", "법인세비용차감전순이익", "ebt"),
    ("38", "법인세비용", "tax_expense"),
    ("39", "당기순이익", "net_income"),
    ("40", "감가상각비", "depreciation"),
    ("41", "무형자산상각비", "amortization"),
    ("42", "EBITDA", None),  # 계산값
]

CF_FIELDS = [
    ("43", "기초자본(SCE)", "beginning_equity"),
    ("44", "배당금 유출", "dividends_paid"),
    ("46", "기말자본(SCE)", "ending_equity_sce"),
    ("47", "영업활동현금흐름(OCF)", "ocf"),
    ("48", "투자활동현금흐름", "investing_cf"),
    ("49", "유형자산의 취득(CAPEX)", "capex"),
    ("50", "재무활동현금흐름", "financing_cf"),
    ("51", "기초현금", "beginning_cash"),
    ("52", "현금의증가", "cash_increase"),
    ("53", "기말현금", "ending_cash"),
]


def _fmt_k(val, decimals=0):
    if val is None:
        return "N/A"
    return f"{round(val, decimals):,.{decimals}f}"


def build_raw_df(periods: list[FinancialData], fields: list[tuple]) -> pd.DataFrame:
    years = [fd.year for fd in periods]
    rows = []
    for no, label, attr in fields:
        row = {"No": no, "계정명": label}
        for fd in periods:
            if attr is None:
                # EBITDA 계산
                row[fd.year] = _fmt_k(fd.ebitda)
            elif attr == "total_borrowings":
                row[fd.year] = _fmt_k(fd.computed_total_borrowings)
            else:
                row[fd.year] = _fmt_k(getattr(fd, attr, None))
        rows.append(row)
    return pd.DataFrame(rows)


# ── 검산 ─────────────────────────────────────────────────────────

def build_validation_df(periods: list[FinancialData]) -> pd.DataFrame:
    rows = []
    checks = [
        ("자산총계 = 유동+비유동",
         lambda fd: fd.total_assets,
         lambda fd: (fd.current_assets or 0) + (fd.non_current_assets or 0)),
        ("부채총계 = 유동+비유동",
         lambda fd: fd.total_liabilities,
         lambda fd: (fd.current_liabilities or 0) + (fd.non_current_liabilities or 0)),
        ("자산=부채+자본",
         lambda fd: fd.total_assets,
         lambda fd: (fd.total_liabilities or 0) + (fd.total_equity or 0)),
        ("매출총이익 = 매출-원가",
         lambda fd: fd.gross_profit,
         lambda fd: (fd.revenue or 0) - (fd.cogs or 0)),
        ("영업이익 = 총이익-판관비",
         lambda fd: fd.operating_income,
         lambda fd: (fd.gross_profit or 0) - (fd.sga or 0)),
        ("기말현금 = 기초+증가",
         lambda fd: fd.ending_cash,
         lambda fd: (fd.beginning_cash or 0) + (fd.cash_increase or 0)),
    ]
    for label, lhs_fn, rhs_fn in checks:
        row = {"검산항목": label}
        for fd in periods:
            lhs, rhs = lhs_fn(fd), rhs_fn(fd)
            if lhs is None or rhs is None:
                row[fd.year] = "N/A"
            else:
                diff = abs(lhs - rhs)
                row[fd.year] = "✅ 일치" if diff <= 2 else f"❌ 불일치(차액 {diff:,.0f}천원)"
        rows.append(row)
    return pd.DataFrame(rows)


# ── 메인 처리 함수 ────────────────────────────────────────────────

def extract_financials(
    ticker: str,
    base_year: int,
    fs_type: str,
    entity_type: str,
    api_key_input: str,
):
    key = api_key_input.strip() or DART_API_KEY
    if not key:
        return [None] * 7 + ["❌ DART API 키를 입력하세요."]

    ticker = ticker.strip()
    fs_div = "OFS" if fs_type == "별도" else "CFS"

    try:
        dart = DartAPI(key)

        # corp_code 조회
        status_msg = f"🔍 {ticker} 종목코드로 DART corp_code 조회 중..."
        corp_code = dart.get_corp_code(ticker)
        if not corp_code:
            return [None] * 7 + [f"❌ 종목코드 [{ticker}]에 해당하는 기업을 찾을 수 없습니다."]

        status_msg = f"✅ corp_code: {corp_code} | 재무제표 수집 중..."

        # 3개년 데이터 수집
        periods = build_3year_data(
            dart_api=dart,
            corp_code=corp_code,
            base_year=base_year,
            fs_div=fs_div,
        )

        # 원시 재무제표 표
        bs_df = build_raw_df(periods, BS_FIELDS)
        is_df = build_raw_df(periods, IS_FIELDS)
        cf_df = build_raw_df(periods, CF_FIELDS)
        val_df = build_validation_df(periods)

        # 지표 계산
        calc = IndicatorCalculator(periods)

        if entity_type == "유형 A (신청기업)":
            ind_rows = calc.calc_type_a()
        elif entity_type == "유형 B (모회사)":
            ind_rows = calc.calc_type_b()
        else:
            ind_rows = calc.calc_type_c()

        ind_df = pd.DataFrame(ind_rows)

        years = [fd.year for fd in periods]
        summary = (
            f"✅ **{ticker}** | {fs_type} | {base_year-2}~{base_year}년 3개년\n\n"
            f"corp_code: `{corp_code}`  |  수집 연도: {', '.join(years)}"
        )

        return bs_df, is_df, cf_df, val_df, ind_df, summary

    except Exception as e:
        return [None] * 5 + [f"❌ 오류 발생: {str(e)}"]


# ── Gradio UI ─────────────────────────────────────────────────────

with gr.Blocks(title="DART 재무데이터 추출기", theme=gr.themes.Soft()) as demo:
    gr.Markdown(
        """
        # 📊 DART 재무데이터 추출기
        금융감독원 전자공시시스템(DART) API로 상장기업 재무제표를 자동 수집·지표 산출합니다.

        > **DART API 키 발급**: [OpenDART 신청](https://opendart.fss.or.kr/uat/uia/easyLogin.do)
        """
    )

    with gr.Row():
        with gr.Column(scale=1):
            api_key_box = gr.Textbox(
                label="DART API 키",
                placeholder="환경변수 DART_API_KEY 미설정 시 여기에 입력",
                type="password",
                value=DART_API_KEY,
            )
            ticker_box = gr.Textbox(
                label="종목코드 (티커)",
                placeholder="예: 005930  (삼성전자)",
            )
            year_slider = gr.Slider(
                label="기준연도 (N)",
                minimum=2018,
                maximum=2024,
                value=2023,
                step=1,
            )
            fs_radio = gr.Radio(
                label="재무제표 구분",
                choices=["별도", "연결"],
                value="별도",
            )
            entity_radio = gr.Radio(
                label="기업 유형 (지표 세트 선택)",
                choices=["유형 A (신청기업)", "유형 B (모회사)", "유형 C (종속/형제기업)"],
                value="유형 A (신청기업)",
            )
            run_btn = gr.Button("🚀 재무데이터 추출", variant="primary")

        with gr.Column(scale=3):
            summary_box = gr.Markdown()

    with gr.Tabs():
        with gr.TabItem("재무상태표 (BS)"):
            bs_table = gr.Dataframe(label="재무상태표 — 단위: 천원", interactive=False)
        with gr.TabItem("손익계산서 (IS)"):
            is_table = gr.Dataframe(label="손익계산서 — 단위: 천원", interactive=False)
        with gr.TabItem("현금흐름/자본변동"):
            cf_table = gr.Dataframe(label="현금흐름표·자본변동표 — 단위: 천원", interactive=False)
        with gr.TabItem("검산"):
            val_table = gr.Dataframe(label="검산 결과", interactive=False)
        with gr.TabItem("📈 재무지표"):
            ind_table = gr.Dataframe(label="재무지표 산출 결과", interactive=False)

    run_btn.click(
        fn=extract_financials,
        inputs=[ticker_box, year_slider, fs_radio, entity_radio, api_key_box],
        outputs=[bs_table, is_table, cf_table, val_table, ind_table, summary_box],
    )

    gr.Markdown(
        """
        ---
        ### 사용 안내
        - **종목코드**: DART에 등록된 6자리 주식 코드 (비상장사 미지원)
        - **기준연도(N)**: 최근 사업연도를 선택하면 N-2~N 3개년을 자동 수집
        - **별도/연결**: 해당 기업의 공시 유형에 맞게 선택
        - **유형 A**: 신청기업 Full-Set 26개 지표
        - **유형 B**: 모회사 지원여력 9개 지표  
        - **유형 C**: 종속/형제기업 리스크 8개 지표
        """
    )


if __name__ == "__main__":
    demo.launch(share=False)
