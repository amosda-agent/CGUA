# 📊 DART 재무데이터 추출기

금융감독원 전자공시시스템(DART) Open API를 사용하여 상장기업의 **3개년 재무제표를 자동 수집하고 재무지표를 산출**하는 Gradio 앱입니다.

[![Hugging Face Spaces](https://img.shields.io/badge/🤗%20Hugging%20Face-Spaces-blue)](https://huggingface.co/spaces/YOUR_USERNAME/dart-financial-extractor)

---

## 🚀 주요 기능

| 기능 | 설명 |
|---|---|
| **종목코드 기반 조회** | 6자리 티커 입력 → corp_code 자동 매핑 |
| **3개년 재무제표 수집** | BS / IS / CF / SCE 53개 항목 자동 추출 |
| **계정명 유연 매핑** | 산업별 특수 계정명도 정규식 패턴으로 자동 인식 |
| **단위 자동 환산** | 원/천원/백만원 → 천원 통일 |
| **검산 자동화** | 6개 BS·IS·CF 항목 수식 검증 |
| **지표 산출 (A/B/C)** | 신청기업 26개 / 모회사 9개 / 종속형제 8개 |

---

## 📁 프로젝트 구조

```
dart_financial_extractor/
├── app.py              # Gradio UI 앱 (Hugging Face Spaces 엔트리포인트)
├── dart_api.py         # DART OpenAPI 클라이언트
├── parser.py           # API 응답 → FinancialData 변환
├── indicators.py       # 재무지표 계산기 (유형 A/B/C)
├── requirements.txt    # 의존 패키지
└── README.md
```

---

## 🛠️ 로컬 실행

```bash
# 1. 패키지 설치
pip install -r requirements.txt

# 2. DART API 키 환경변수 설정
export DART_API_KEY="your_api_key_here"

# 3. 앱 실행
python app.py
```

DART API 키는 [OpenDART](https://opendart.fss.or.kr/uat/uia/easyLogin.do)에서 무료 발급 가능합니다.

---

## ☁️ Hugging Face Spaces 배포

```bash
# HF CLI 로그인
pip install huggingface_hub
huggingface-cli login

# Spaces 생성 후 업로드
huggingface-cli repo create dart-financial-extractor --type space --space_sdk gradio

git remote add hf https://huggingface.co/spaces/YOUR_USERNAME/dart-financial-extractor
git push hf main
```

Spaces의 **Settings → Secrets**에 `DART_API_KEY`를 등록하면 UI에 API 키를 입력하지 않아도 됩니다.

---

## 📊 지표 산출 세트

### 유형 A — 신청기업 (26개)
성장성 5 · 수익성 8 · 안정성 6 · 활동성 4 · 현금흐름 3

### 유형 B — 모회사 (9개)
안정성 4 · 지원여력 3 · 수익성 2

### 유형 C — 종속/형제기업 (8개)
리스크 3 · 안정성 2 · 상호의존도 3

---

## ⚠️ 주의사항

- 비상장 기업은 DART corp_code가 없어 종목코드 기반 조회 불가 (corp_name 검색 별도 지원)
- 산업 특수 계정(예: 보험업 영업수익, 금융업 이자수익)은 자동 매핑 후 비고 확인 권장
- API 응답의 단위(`thstrm_amount`)는 기업·보고서 종류별로 원/천원이 혼재할 수 있으니 검산 탭에서 반드시 확인

---

## 📄 라이선스

MIT License
