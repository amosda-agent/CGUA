import { useState, useRef, useCallback } from "react";

const PHASES = [
  { id: "upload", label: "파일 등록", icon: "⬆" },
  { id: "extract", label: "데이터 추출", icon: "1" },
  { id: "metrics", label: "지표 산출", icon: "2" },
  { id: "analysis1", label: "심사 1단계", icon: "3" },
  { id: "analysis2", label: "심사 2단계", icon: "4" },
  { id: "related", label: "관계기업", icon: "5" },
  { id: "account", label: "회계검증", icon: "6" },
  { id: "risk", label: "리스크", icon: "7" },
  { id: "final", label: "통합보고서", icon: "✦" },
];

const TAG = {
  subject: { label: "신청업체", bg: "#dbeafe", color: "#1e40af" },
  related: { label: "관계기업", bg: "#dcfce7", color: "#166534" },
};

const BC = {
  blue:  { bg: "#dbeafe", color: "#1e40af" },
  purple:{ bg: "#ede9fe", color: "#5b21b6" },
  amber: { bg: "#fef3c7", color: "#92400e" },
  green: { bg: "#dcfce7", color: "#166534" },
  red:   { bg: "#fee2e2", color: "#991b1b" },
  navy:  { bg: "#1e3a5f", color: "#fff" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



// ── 프롬프트 빌더 ────────────────────────────────────────────────
const COMMON =
  "너는 한국무역보험공사(KSURE)의 비외감기업 신용보증 심사역이다. 단위 백만원, 비율 소수점 1자리, 연환산(scaling) 금지(누적값 사용), 자료에 없는 값은 'N/A'로만 표기하고 추측 금지. 모든 서술은 한국어이며 신용보증 심사 관점에서 사실에 근거해 작성한다. 출력은 JSON만, 마크다운·코드펜스·설명 금지.";

const ctxText = (ctx) => (ctx ? `\n\n[재무 데이터]\n${ctx}` : "");

// 한 번의 호출로 여러 표(재무제표)를 추출 — 파일은 이 단계에서만 전송
const multitablePrompt = (task, ctx) =>
  `${COMMON}\n\n[작업] ${task}\n반드시 다음 형식의 JSON만: {"tables":[{"heading":"제목","headers":["..."],"rows":[["...","..."]]}]}\n감소 수치는 '▲' 접두. 셀 텍스트는 간결하게. 각 표의 행 수 상한을 반드시 지킬 것.${ctxText(ctx)}`;

const tablePrompt = (task, ctx) =>
  `${COMMON}\n\n[작업] ${task}\n반드시 다음 형식의 JSON만: {"heading":"제목","headers":["열1","열2","..."],"rows":[["...","..."]]}\n감소 수치는 '▲' 접두. 행은 핵심 항목 위주. 사유·근거·평가 열은 35자 이내.${ctxText(ctx)}`;

const checkPrompt = (task, ctx) =>
  `${COMMON}\n\n[작업] ${task}\n반드시 다음 형식: {"heading":"제목","items":[{"label":"검산 항목","result":"산식과 결과를 한 문장으로","ok":true}]}\n불일치는 ok를 false로 하고 result에 사유 명시. result는 60자 이내.${ctxText(ctx)}`;

// issue 항목 여러 개를 1회 호출로 처리
const batchIssuePrompt = (topics, ctx) =>
  `${COMMON}\n\n[분석 작업] 아래 ${topics.length}개 항목을 순서대로 분석하라.\n${topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n반드시 다음 형식의 JSON만: {"items":[{"title":"결론 한 문장","content":"[결산기준]·[기중보완]·[결론] 흐름으로 3~4문장, 핵심 수치 인용","type":"ok"}]}\ntype은 긍정 "ok", 주의 "warn", 위험 "risk". items 배열 길이는 반드시 ${topics.length}.${ctxText(ctx)}`;

const finalPrompt = (task, ctx) =>
  `${COMMON}\n\n[작업] ${task}\n반드시 다음 형식: {"verdict":"...","limit":"권고 한도 문자열","summary":"..."}\nsummary는 긍정 근거·리스크 요인·승인 조건을 포함해 5~7문장으로 작성.${ctxText(ctx)}`;

// ── ctx 슬라이서: 단계별로 필요한 데이터만 추출 ──────────────────
// ctxStore = { bs, is, cf, metrics }
const sliceCtx = (need, store) => {
  const parts = [];
  if (need.includes("bs") && store.bs) parts.push(store.bs);
  if (need.includes("is") && store.is) parts.push(store.is);
  if (need.includes("cf") && store.cf) parts.push(store.cf);
  if (need.includes("metrics") && store.metrics) parts.push(store.metrics);
  return parts.join("\n");
};

// ── 단계 정의 ─────────────────────────────────────────────────────
// ctxNeed: 해당 단계에서 실제로 필요한 데이터 키 목록
const STAGES = [
  { phaseId: "extract", group: "extract", reportPhase: "PHASE 1 — 재무제표 추출 (BS·IS·CF)", badge: "P1-추출", bc: BC.blue, src: "subject", store: true,
    sections: [{ type: "multitable", task: "업로드된 재무제표에서 재무상태표(BS)·손익계산서(IS)·현금흐름표(CF)를 한 번에 추출하라. tables 배열에 세 표를 순서대로 담는다. (1) BS: 유동/비유동 자산·부채·자본총계와 현금·매출채권·재고·차입금 등 핵심계정+합계행, 최대 14행, heading '재무상태표 (단위: 백만원)'. (2) IS: 매출액·매출원가·매출총이익·판관비·영업이익·영업외손익·세전이익·법인세·당기순이익, 최대 11행, heading '손익계산서 (단위: 백만원)'. (3) CF: 영업·투자·재무활동·현금증감·기초/기말현금, 최대 7행, heading '현금흐름표 (단위: 백만원)'. CF 자료가 없으면 한 행 ['현금흐름표','미제출','미제출','-']. 모든 표 headers는 ['항목','전기','당기','증감']." }] },
  { phaseId: "extract", group: "verify", reportPhase: "PHASE 1 — 검산 (정합성 검증)", badge: "P1-검산", bc: BC.purple, src: "ctx", ctxNeed: ["bs","is","cf"],
    sections: [{ type: "check", task: "앞 추출 데이터로 6~8개 검산을 수행하라. BS 항등식, 매출총이익=매출액-매출원가, 영업이익=매출총이익-판관비, CF 기초+증감=기말, 부채비율·유동비율·자기자본비율 검증 등." }] },
  { phaseId: "metrics", group: "verify", reportPhase: "PHASE 1 — 재무지표 산출", badge: "P1-지표", bc: BC.purple, src: "ctx", store: true, ctxNeed: ["bs","is","cf"],
    sections: [{ type: "table", task: "성장성·수익성·안정성·활동성·현금흐름 5개 구분으로 재무지표를 산출하라. 산출 불가 지표는 'N/A'. heading '재무지표 산출 결과', headers ['구분','지표명','전기','당기']." }] },
  { phaseId: "analysis1", group: "analyze", reportPhase: "심사 1단계 — 경영성과 및 재무안정성", badge: "1단계", bc: BC.amber, src: "ctx", ctxNeed: ["is","metrics"],
    sections: [{ type: "issue", heading: "핵심 이슈 분석", items: [
      "매출 성장세와 수익성(매출총이익률·영업이익률) 변화를 분석하라.",
      "부채비율·자기자본비율 등 재무안정성 변화와 그 원인(차입 vs 이익유보)을 분석하라.",
      "판매관리비 등 비용구조 변화가 영업이익에 미친 영향을 분석하라.",
    ] }] },
  { phaseId: "analysis2", group: "analyze", reportPhase: "심사 2단계 — 자산운용 및 현금흐름", badge: "2단계", bc: BC.green, src: "ctx", ctxNeed: ["bs","is","cf","metrics"],
    sections: [
      { type: "table", task: "자산운용 효율성 표를 작성하라. 매출채권·재고·매입채무 회전일수, 현금전환주기(CCC), 총자산회전율 등과 전기 대비 평가. heading '자산운용 효율성', headers ['지표','전기','당기','평가']." },
      { type: "issue", heading: "현금흐름·종합진단", items: [
        "영업활동현금흐름(OCF)의 규모와 질(당기순이익 대비)을 분석하라.",
        "투자·재무활동 현금흐름과 잉여현금흐름(FCF)을 분석하라.",
        "외형성장·현금창출력·재무안정성을 종합한 재무 종합진단을 내려라.",
      ] },
    ] },
  { phaseId: "related", group: "analyze", reportPhase: "3단계 — 관계기업 신용도·리스크 전이", badge: "3단계", bc: BC.green, src: "related", relatedOnly: true, ctxNeed: [],
    sections: [{ type: "issue", heading: "관계기업 분석", items: [
      "관계기업의 재무상태와 신용도를 분석하라.",
      "관계기업에서 신청업체로의 리스크 전이 경로와 가능성을 분석하라.",
    ] }] },
  { phaseId: "account", group: "analyze", reportPhase: "4단계 — 회계 신뢰성 검증 및 한도 산출", badge: "4단계", bc: BC.red, src: "ctx", ctxNeed: ["bs","is","metrics"],
    sections: [
      { type: "table", task: "회계 신뢰성 평가표를 작성하라(100점 만점). 재무제표완결성·검산정합성·계정일관성·수치신뢰도·보완자료충실도 각 20점과 합계행. 비외감기업 특성 반영. 평가 사유 열은 35자 이내. heading '회계 신뢰성 평가표 (100점 만점)', headers ['평가 항목','배점','취득점수','평가 사유']." },
      { type: "table", task: "시나리오별 신용보증한도 표를 작성하라. 기본·우대·보수 3개 시나리오, 각 산출 한도와 근거(40자 이내). heading '시나리오별 신용보증한도', headers ['시나리오','산출 한도','적용 조건 및 근거']." },
      { type: "issue", heading: "산출 상세", items: [
        "회계 신뢰성 평가 결과(총점·등급)와 보완 권고사항을 서술하라.",
        "기본·우대·보수 한도 산출 근거와 적정 승인 한도 의견을 서술하라.",
      ] },
    ] },
  { phaseId: "risk", group: "analyze", reportPhase: "5단계 — 요약 및 리스크보고서", badge: "5단계", bc: BC.green, src: "ctx", ctxNeed: ["is","cf","metrics"],
    sections: [
      { type: "issue", heading: "3대 핵심 요약", items: [
        "영업·현금흐름 측면의 긍정 요인을 요약하라.",
        "재무안정성 측면의 긍정 요인을 요약하라.",
        "수익성·비용 측면의 유의 요인을 요약하라.",
      ] },
      { type: "issue", heading: "리스크보고서", items: [
        "원가·매출원가율 측면의 위험을 서술하라.",
        "매출처 편중·거래처 의존 측면의 위험을 서술하라.",
        "차입구조·금리 상승 노출 측면의 위험을 서술하라.",
        "외감 미대상에 따른 재무제표 신뢰성 한계를 서술하라.",
      ] },
    ] },
  { phaseId: "final", group: "final", reportPhase: "6단계 — 통합보고서 최종 의결", badge: "통합", bc: BC.navy, src: "ctx", ctxNeed: ["is","metrics"],
    sections: [{ type: "final", task: "전 단계를 종합한 최종 의결을 내려라. verdict는 자료 근거에 따라 '신용보증 공급 가능'·'조건부 공급 가능'·'공급 곤란' 중 선택하고, limit은 권고 한도 문자열로 제시하라." }] },
];

// 파일 → base64
const fileToB64 = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("read fail"));
    r.readAsDataURL(file);
  });

const mediaType = (name) => {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return { kind: "document", mt: "application/pdf" };
  if (n.endsWith(".png")) return { kind: "image", mt: "image/png" };
  return { kind: "image", mt: "image/jpeg" };
};

const cleanJSON = (text) => {
  let t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const a = t.indexOf("{");
  if (a > 0) t = t.slice(a);
  // 문자열 토큰 밖의 제어문자를 공백으로 치환
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) { esc = false; out += c; }
      else if (c === "\\") { esc = true; out += c; }
      else if (c === '"') { inStr = false; out += c; }
      else { out += c; }
    } else {
      if (c === '"') { inStr = true; out += c; }
      else if (c < " ") { out += " "; }
      else { out += c; }
    }
  }
  return out;
};

// 잘린/오염 JSON 복구: 마지막으로 완성된 지점까지 살려 열린 괄호를 닫음
const repairJSON = (s) => {
  let inStr = false, esc = false, opened = false, lastSafe = -1;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') { inStr = false; lastSafe = i + 1; }
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") { stack.push(c === "{" ? "}" : "]"); opened = true; }
    else if (c === "}" || c === "]") { stack.pop(); lastSafe = i + 1; if (opened && stack.length === 0) break; }
    else if (c === ",") lastSafe = i;
    else if (/[0-9.\-eEtfnaurls]/.test(c)) lastSafe = i + 1;
  }
  if (lastSafe <= 0) throw new Error("응답이 손상되어 복구 불가");
  let body = s.slice(0, lastSafe).replace(/[\s,:]+$/, "");
  const st = [];
  let inS = false, es = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inS) { if (es) es = false; else if (c === "\\") es = true; else if (c === '"') inS = false; continue; }
    if (c === '"') inS = true;
    else if (c === "{") st.push("}");
    else if (c === "[") st.push("]");
    else if (c === "}" || c === "]") st.pop();
  }
  let close = "";
  for (let i = st.length - 1; i >= 0; i--) close += st[i];
  return JSON.parse(body + close);
};

const parseJSON = (text) => {
  const t = cleanJSON(text);
  try { return JSON.parse(t); }
  catch (e) { return repairJSON(t); }
};

// 자동 재시도(지수 백오프) 포함 순차 호출
// maxTokens: table/check/final=1000, batch issue(항목 여러개)=2500
async function callClaude(blocks, promptText, stats, retries = 2, maxTokens = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: [...blocks, { type: "text", text: promptText }] }],
        }),
      });
      if (resp.status === 429 || resp.status >= 500) throw new Error("API " + resp.status + " 일시오류");
      if (!resp.ok) throw new Error("API " + resp.status);
      const data = await resp.json();
      if (stats) { stats.calls += 1; if (data.usage) { stats.inTok += data.usage.input_tokens || 0; stats.outTok += data.usage.output_tokens || 0; } }
      const text = (data.content || []).map((i) => (i.type === "text" ? i.text : "")).filter(Boolean).join("\n");
      if (!text) throw new Error("빈 응답");
      return parseJSON(text);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(700 * (attempt + 1) + Math.random() * 500);
    }
  }
  throw lastErr;
}

// ── 섹션 렌더러 ────────────────────────────────────────────────────
function SectionBlock({ sec }) {
  const issueColors = {
    ok:   { bg: "#f0fdf4", border: "#86efac", label: "#15803d" },
    warn: { bg: "#fffbeb", border: "#fcd34d", label: "#92400e" },
    risk: { bg: "#fff1f2", border: "#fca5a5", label: "#991b1b" },
  };
  if (sec.type === "table") return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: "#222", marginBottom: 6 }}>{sec.heading}</p>
      <div style={{ border: "0.5px solid #d8dde3", borderRadius: 8, overflow: "hidden", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ background: "#1e3a5f" }}>
              {(sec.headers || []).map((h, i) => (
                <th key={i} style={{ padding: "7px 10px", color: "#fff", fontWeight: 600, textAlign: i === 0 ? "left" : "center", fontSize: 11, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(sec.rows || []).map((row, ri) => {
              const c0 = String(row[0] || "");
              const isTotal = /총계|합계|총자산|총부채/.test(c0);
              return (
                <tr key={ri} style={{ borderTop: "0.5px solid #e3e7ec", background: isTotal ? "#eef2f7" : ri % 2 === 0 ? "#fff" : "#f7f9fb" }}>
                  {row.map((cell, ci) => {
                    const v = String(cell);
                    return (
                      <td key={ci} style={{ padding: "7px 10px", textAlign: ci === 0 ? "left" : "center", color: v.startsWith("▲") || v.startsWith("✕") ? "#dc2626" : v.startsWith("✓") ? "#16a34a" : "#222", fontWeight: ci === 0 || isTotal ? 600 : 400, whiteSpace: ci === 0 ? "nowrap" : "normal" }}>{v.trim()}</td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
  if (sec.type === "check") return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: "#222", marginBottom: 6 }}>{sec.heading}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {(sec.items || []).map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: 6, background: it.ok ? "#f0fdf4" : "#fff1f2", border: `0.5px solid ${it.ok ? "#86efac" : "#fca5a5"}` }}>
            <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1, color: it.ok ? "#15803d" : "#dc2626", fontWeight: 700 }}>{it.ok ? "✓" : "✕"}</span>
            <div>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: it.ok ? "#15803d" : "#dc2626" }}>{it.label}</span>
              <p style={{ fontSize: 11, color: it.ok ? "#4b5563" : "#991b1b", margin: "3px 0 0", lineHeight: 1.6 }}>{it.result}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  if (sec.type === "issue") return (
    <div style={{ marginBottom: 16 }}>
      <p style={{ fontSize: 12, fontWeight: 600, color: "#222", marginBottom: 6 }}>{sec.heading}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(sec.items || []).map((it, i) => {
          const c = issueColors[it.type] || issueColors.warn;
          return (
            <div key={i} style={{ padding: "11px 13px", borderRadius: 8, background: c.bg, border: `0.5px solid ${c.border}` }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: c.label, margin: "0 0 5px" }}>{it.title}</p>
              <p style={{ fontSize: 11.5, color: "#222", margin: 0, lineHeight: 1.75, textAlign: "justify" }}>{it.content}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
  if (sec.type === "final") return (
    <div style={{ padding: "16px", background: "#f0f6ff", border: "1.5px solid #2563eb", borderRadius: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 22 }}>✅</span>
        <div>
          <p style={{ fontSize: 13, fontWeight: 700, color: "#1e3a5f", margin: 0 }}>{sec.verdict}</p>
          {sec.limit && <p style={{ fontSize: 12, color: "#2563eb", margin: "2px 0 0", fontWeight: 600 }}>신용보증한도: {sec.limit}</p>}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "#222", margin: 0, lineHeight: 1.85, textAlign: "justify" }}>{sec.summary}</p>
    </div>
  );
  return null;
}

// ── 통합보고서 뷰 ──────────────────────────────────────────────────
function ReportView({ report, onClose }) {
  const downloadHtml = () => {
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const issueBg = { ok: "#f0fdf4", warn: "#fffbeb", risk: "#fff1f2" };
    const issueBorder = { ok: "#86efac", warn: "#fcd34d", risk: "#fca5a5" };
    const secHtml = (sec) => {
      if (sec.type === "table") return `<p class="sec">${esc(sec.heading)}</p><table><thead><tr>${(sec.headers||[]).map((h,i)=>`<th class="${i===0?"l":"c"}">${esc(h)}</th>`).join("")}</tr></thead><tbody>${(sec.rows||[]).map((r)=>`<tr>${r.map((c,i)=>`<td class="${i===0?"l":"c"}">${esc(String(c).trim())}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      if (sec.type === "check") return `<p class="sec">${esc(sec.heading)}</p>${(sec.items||[]).map((it)=>`<div class="box" style="background:${it.ok?"#f0fdf4":"#fff1f2"};border-color:${it.ok?"#86efac":"#fca5a5"};"><b>${it.ok?"✓":"✕"} ${esc(it.label)}</b>${esc(it.result)}</div>`).join("")}`;
      if (sec.type === "issue") return `<p class="sec">${esc(sec.heading)}</p>${(sec.items||[]).map((it)=>`<div class="box" style="background:${issueBg[it.type]||"#fffbeb"};border-color:${issueBorder[it.type]||"#fcd34d"};"><b>${esc(it.title)}</b>${esc(it.content)}</div>`).join("")}`;
      if (sec.type === "final") return `<div class="final"><p class="verdict">✅ ${esc(sec.verdict)}</p>${sec.limit?`<p class="limit">신용보증한도: ${esc(sec.limit)}</p>`:""}<p class="fsum">${esc(sec.summary)}</p></div>`;
      return "";
    };
    const body = (report.phases||[]).map((ph)=>`<div class="phase"><p class="phdr">[${esc(ph.badge)}] ${esc(ph.phase)}</p>${(ph.sections||[]).map(secHtml).join("")}</div>`).join("");
    const statsLine = report.stats ? `<p class="stats">분석 소요 ${esc(report.stats.sec)}초 · API 호출 ${report.stats.calls}회 · 토큰 ${report.stats.total.toLocaleString()} (입력 ${report.stats.inTok.toLocaleString()} / 출력 ${report.stats.outTok.toLocaleString()})</p>` : "";
    const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${esc(report.title)}</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:11pt;color:#111;background:#f4f6f9;padding:24px;}.wrap{max-width:820px;margin:0 auto;background:#fff;padding:32px 32px 40px;box-shadow:0 2px 12px rgba(0,0,0,.08);border-radius:8px;}h1{font-size:20pt;text-align:center;color:#1e3a5f;margin-bottom:6px;}.meta{text-align:center;font-size:10pt;color:#555;margin-bottom:4px;}.stats{text-align:center;font-size:9pt;color:#888;padding-bottom:16px;border-bottom:2px solid #1e3a5f;margin-bottom:24px;}.phase{margin-bottom:26px;}.phdr{background:#1e3a5f;color:#fff;padding:7px 12px;font-size:12pt;font-weight:700;border-radius:5px;margin-bottom:10px;}.sec{font-size:11pt;font-weight:600;color:#1e3a5f;margin:10px 0 6px;}table{width:100%;border-collapse:collapse;font-size:10pt;margin-bottom:10px;}th{background:#1e3a5f;color:#fff;padding:6px 9px;font-weight:600;}td{padding:6px 9px;border:0.5px solid #d8dde3;}tr:nth-child(even) td{background:#f7f9fb;}.l{text-align:left;}.c{text-align:center;}.box{padding:9px 12px;margin-bottom:6px;border:0.5px solid #ddd;border-radius:6px;font-size:10pt;line-height:1.7;text-align:justify;}.box b{display:block;margin-bottom:4px;color:#222;}.final{background:#f0f6ff;border:1.5px solid #2563eb;border-radius:8px;padding:14px 16px;}.verdict{font-size:13pt;font-weight:700;color:#1e3a5f;margin-bottom:4px;}.limit{font-size:11pt;color:#2563eb;font-weight:600;margin-bottom:8px;}.fsum{font-size:10pt;line-height:1.8;text-align:justify;}.footer{margin-top:28px;text-align:center;font-size:9pt;color:#aaa;border-top:0.5px solid #ddd;padding-top:12px;}@media print{body{background:#fff;padding:0;}.wrap{box-shadow:none;max-width:100%;}}</style></head><body><div class="wrap"><h1>${esc(report.title)}</h1><p class="meta">기준일: ${esc(report.date)} &nbsp;|&nbsp; 대상: ${esc(report.company)}</p>${statsLine}${body}<p class="footer">KSURE 비외감기업 신용보증 심사 에이전트 | 병렬·단일추출 보고서</p></div></body></html>`;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "신용보증_심사_보고서.html";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#fff", zIndex: 9999, display: "flex", alignItems: "flex-start", justifyContent: "center", overflowY: "auto", padding: "0 0 40px" }}>
      <div style={{ width: "100%", maxWidth: 760 }}>
        <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#1e3a5f", padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", boxShadow: "0 2px 8px rgba(0,0,0,.15)" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>📄 동적 통합보고서</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={downloadHtml} style={{ padding: "8px 16px", background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.35)", borderRadius: 7, color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>⬇ HTML 다운로드</button>
            <button onClick={onClose} style={{ padding: "8px 14px", background: "rgba(255,255,255,.1)", border: "1px solid rgba(255,255,255,.25)", borderRadius: 7, color: "#fff", fontSize: 12.5, cursor: "pointer" }}>닫기</button>
          </div>
        </div>
        <div style={{ background: "#fff", padding: "28px 28px 36px" }}>
          <div style={{ textAlign: "center", paddingBottom: 16, borderBottom: "2px solid #1e3a5f", marginBottom: 24 }}>
            <p style={{ fontSize: 10, color: "#888", letterSpacing: 2, marginBottom: 8 }}>KSURE 비외감기업 신용보증 심사 에이전트</p>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: "#1e3a5f", margin: "0 0 8px" }}>{report.title}</h2>
            <p style={{ fontSize: 12, color: "#555", margin: 0 }}>기준일: {report.date} &nbsp;|&nbsp; 대상: {report.company}</p>
            {report.stats && <p style={{ fontSize: 10.5, color: "#888", margin: "6px 0 0" }}>분석 소요 {report.stats.sec}초 · API 호출 {report.stats.calls}회 · 토큰 {report.stats.total.toLocaleString()} (입력 {report.stats.inTok.toLocaleString()} / 출력 {report.stats.outTok.toLocaleString()})</p>}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
            {(report.phases || []).map((ph, pi) => (
              <div key={pi}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, paddingBottom: 8, borderBottom: "1.5px solid #1e3a5f" }}>
                  <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 999, background: ph.badgeColor.bg, color: ph.badgeColor.color, fontWeight: 700 }}>{ph.badge}</span>
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: "#1e3a5f", margin: 0 }}>{ph.phase}</h3>
                </div>
                {(ph.sections || []).map((sec, si) => <SectionBlock key={si} sec={sec} />)}
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", marginTop: 28, paddingTop: 14, borderTop: "0.5px solid #ddd", fontSize: 11, color: "#aaa" }}>✅ 업로드 파일 기반 동적분석 완료 &nbsp;|&nbsp; KSURE 심사 에이전트</div>
        </div>
      </div>
    </div>
  );
}

// ── 메인 앱 ────────────────────────────────────────────────────────
export default function App() {
  const [files, setFiles] = useState([]);
  const [tab, setTab] = useState("upload");
  const [running, setRunning] = useState(false);
  const [currentPhase, setCurrentPhase] = useState(null);
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState([]);
  const [done, setDone] = useState(false);
  const [report, setReport] = useState(null);
  const [stats, setStats] = useState(null);
  const [showReport, setShowReport] = useState(false);
  const [settings, setSettings] = useState({ includeRelated: true, includeIndustry: false });
  const fileInput = useRef();
  const logRef = useRef();

  const addFiles = useCallback((flist) => {
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name));
      const items = Array.from(flist).filter((f) => !names.has(f.name)).map((f) => ({ file: f, name: f.name, type: "subject" }));
      return [...prev, ...items];
    });
  }, []);

  const onDrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };
  const addLog = (msg, type = "info") => {
    setLogs((prev) => [...prev, { msg, type }]);
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 50);
  };

  const startAnalysis = async () => {
    const subjects = files.filter((f) => f.type === "subject");
    const related = files.filter((f) => f.type === "related");
    if (!subjects.length) return;
    const hasRelated = related.length > 0 && settings.includeRelated;

    setRunning(true); setDone(false); setLogs([]); setResults([]); setProgress(0); setShowReport(false); setReport(null); setStats(null); setTab("progress");
    addLog("심사 에이전트 초기화...", "system");
    const t0 = performance.now();

    let subjectBlocks = [], relatedBlocks = [];
    try {
      addLog("업로드 파일 인코딩 중...", "info");
      subjectBlocks = await Promise.all(subjects.map(async (f) => {
        const { kind, mt } = mediaType(f.name);
        return { type: kind, source: { type: "base64", media_type: mt, data: await fileToB64(f.file) } };
      }));
      relatedBlocks = await Promise.all(related.map(async (f) => {
        const { kind, mt } = mediaType(f.name);
        return { type: kind, source: { type: "base64", media_type: mt, data: await fileToB64(f.file) } };
      }));
    } catch (e) {
      addLog("✕ 파일 인코딩 실패: " + e.message, "error");
      setRunning(false); return;
    }
    addLog(`✓ 신청업체 ${subjects.length}개 / 관계기업 ${related.length}개`, "ok");
    addLog("⚡ 추출 1회 + 배치·슬림 ctx 순차 분석 (자동 재시도)", "system");

    const company = subjects[0].name.replace(/\.[^.]+$/, "");
    const now = new Date();
    const dateStr = `${String(now.getFullYear()).slice(2)}.${String(now.getMonth() + 1).padStart(2, "0")}월`;
    const title = "비외감기업 신용보증 심사 통합보고서";

    const statsAcc = { calls: 0, inTok: 0, outTok: 0 };
    const activeStages = STAGES.filter((s) => !s.relatedOnly || hasRelated);
    const totalCalls = activeStages.reduce((a, st) => a + st.sections.length, 0);
    let doneCalls = 0;
    const bump = () => { doneCalls += 1; setProgress(Math.min(99, Math.round((doneCalls / totalCalls) * 100))); };

    const resultMap = {};
    const rebuild = () => {
      const phases = activeStages.map((s) => resultMap[s.reportPhase]).filter(Boolean);
      setReport({ title, date: dateStr, company, phases });
      setResults(phases.map((b) => ({ label: b.phase, ok: b._ok !== false })));
    };

    // runSection은 항상 섹션 배열을 반환 (multitable은 여러 표로 확장)
    const runSection = async (sec, blocks, ctxArg) => {
      if (sec.type === "multitable") {
        try {
          const o = await callClaude(blocks, multitablePrompt(sec.task, ctxArg), statsAcc); bump();
          const tables = Array.isArray(o.tables) ? o.tables : [];
          if (!tables.length) throw new Error("표 데이터 없음");
          return tables.map((t) => ({ type: "table", heading: t.heading || "표", headers: t.headers || ["항목", "전기", "당기", "증감"], rows: t.rows || [], _ok: true }));
        } catch (e) { bump(); return [{ type: "issue", heading: "생성 오류", items: [{ title: "재무제표 추출 실패", content: "사유: " + e.message, type: "risk", _err: true }], _ok: false }]; }
      }
      if (sec.type === "table") {
        try { const o = await callClaude(blocks, tablePrompt(sec.task, ctxArg), statsAcc); bump(); return [{ type: "table", heading: o.heading || "표", headers: o.headers || [], rows: o.rows || [], _ok: true }]; }
        catch (e) { bump(); return [{ type: "issue", heading: "생성 오류", items: [{ title: "표를 생성하지 못했습니다", content: "사유: " + e.message, type: "risk", _err: true }], _ok: false }]; }
      }
      if (sec.type === "check") {
        try { const o = await callClaude(blocks, checkPrompt(sec.task, ctxArg), statsAcc); bump(); return [{ type: "check", heading: o.heading || "검산 결과", items: o.items || [], _ok: true }]; }
        catch (e) { bump(); return [{ type: "issue", heading: "생성 오류", items: [{ title: "검산을 완료하지 못했습니다", content: "사유: " + e.message, type: "risk", _err: true }], _ok: false }]; }
      }
      if (sec.type === "final") {
        try { const o = await callClaude(blocks, finalPrompt(sec.task, ctxArg), statsAcc); bump(); return [{ type: "final", verdict: o.verdict || "의결 보류", limit: o.limit || "", summary: o.summary || "", _ok: true }]; }
        catch (e) { bump(); return [{ type: "issue", heading: "생성 오류", items: [{ title: "최종 의결을 완료하지 못했습니다", content: "사유: " + e.message, type: "risk", _err: true }], _ok: false }]; }
      }
      // issue: 항목 전체를 1회 배치 호출
      try {
        const o = await callClaude(blocks, batchIssuePrompt(sec.items, ctxArg), statsAcc, 2, 2500);
        bump();
        const raw = Array.isArray(o.items) ? o.items : [];
        const items = sec.items.map((_, k) => {
          const r = raw[k];
          return r ? { title: r.title || `분석 항목 ${k + 1}`, content: r.content || "", type: r.type || "warn" }
                   : { title: `분석 항목 ${k + 1} 누락`, content: "응답에서 해당 항목을 찾을 수 없습니다.", type: "risk", _err: true };
        });
        return [{ type: "issue", heading: sec.heading, items, _ok: !items.some((it) => it._err) }];
      } catch (e) {
        bump();
        return [{ type: "issue", heading: sec.heading, items: [{ title: "분석 생성 오류", content: "사유: " + e.message, type: "risk", _err: true }], _ok: false }];
      }
    };

    const runStage = async (stage, ctxStore) => {
      setCurrentPhase(stage.phaseId);
      const blocks = stage.src === "subject" ? subjectBlocks : stage.src === "related" ? relatedBlocks : [];
      const ctxArg = stage.src === "ctx" ? sliceCtx(stage.ctxNeed || [], ctxStore) : "";
      const secs = [];
      for (const sec of stage.sections) {
        const result = await runSection(sec, blocks, ctxArg);
        secs.push(...result);
      }
      const block = { phase: stage.reportPhase, badge: stage.badge, badgeColor: stage.bc, sections: secs, _ok: secs.every((s) => s._ok !== false) };
      resultMap[stage.reportPhase] = block;
      rebuild();
      addLog(`✓ ${stage.reportPhase}`, block._ok ? "ok" : "error");
      return block;
    };

    // ctxStore: 표 종류별로 분리 저장 (슬리밍용)
    const ctxStore = { bs: "", is: "", cf: "", metrics: "" };
    const tableToText = (sec) => `${sec.heading}\n` + (sec.rows || []).map((r) => r.join(" | ")).join("\n");
    const storeBlock = (block) => {
      block.sections.forEach((sec) => {
        if (sec.type !== "table") return;
        const h = sec.heading || "";
        if (/재무상태표|BS/.test(h))      ctxStore.bs      = tableToText(sec);
        else if (/손익계산서|IS/.test(h)) ctxStore.is      = tableToText(sec);
        else if (/현금흐름표|CF/.test(h)) ctxStore.cf      = tableToText(sec);
        else if (/재무지표/.test(h))      ctxStore.metrics = tableToText(sec);
      });
    };

    try {
      // 그룹 1: 추출 (파일 1회 전송)
      const g1 = activeStages.filter((s) => s.group === "extract");
      const r1 = [];
      for (const st of g1) { const b = await runStage(st, ctxStore); r1.push(b); }
      r1.forEach((b, i) => { if (g1[i].store) storeBlock(b); });

      // 그룹 2: 검산·지표 (BS+IS+CF만 전달)
      const g2 = activeStages.filter((s) => s.group === "verify");
      const r2 = [];
      for (const st of g2) { const b = await runStage(st, ctxStore); r2.push(b); }
      r2.forEach((b, i) => { if (g2[i].store) storeBlock(b); });

      // 그룹 3: 심사·관계기업·검증·리스크 (단계별 필요 키만 전달)
      const g3 = activeStages.filter((s) => s.group === "analyze");
      for (const st of g3) await runStage(st, ctxStore);

      // 그룹 4: 최종 의결
      const g4 = activeStages.filter((s) => s.group === "final");
      for (const st of g4) await runStage(st, ctxStore);
    } catch (e) {
      addLog("✕ 분석 중 오류: " + e.message, "error");
    }

    setCurrentPhase("done");
    setProgress(100);
    const elapsed = (performance.now() - t0) / 1000;
    const finalStats = { sec: elapsed.toFixed(1), calls: statsAcc.calls, inTok: statsAcc.inTok, outTok: statsAcc.outTok, total: statsAcc.inTok + statsAcc.outTok };
    setStats(finalStats);
    setReport((r) => (r ? { ...r, stats: finalStats } : r));
    addLog(`━━ 완료 · ${finalStats.sec}초 · 호출 ${finalStats.calls}회 · 토큰 ${finalStats.total.toLocaleString()} ━━`, "system");
    setDone(true); setRunning(false);
  };

  const reset = () => { setFiles([]); setLogs([]); setResults([]); setProgress(0); setCurrentPhase(null); setDone(false); setRunning(false); setShowReport(false); setReport(null); setStats(null); setTab("upload"); };
  const phaseIdx = (id) => PHASES.findIndex((p) => p.id === id);
  const curIdx = currentPhase === "done" ? PHASES.length : phaseIdx(currentPhase);

  return (
    <div style={{ fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif", padding: "0 0 2rem", maxWidth: 720, margin: "0 auto" }}>
      {showReport && report && <ReportView report={report} onClose={() => setShowReport(false)} />}

      <div style={{ padding: "1.5rem 0 1rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#1e3a5f", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 15, fontWeight: 700 }}>K</div>
          <h1 style={{ fontSize: 16, fontWeight: 600, color: "var(--color-text-primary)", margin: 0 }}>비외감기업 신용보증 심사 에이전트</h1>
        </div>
        <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>추출 1회 + issue 배치 호출 + 단계별 슬림 ctx · 자동 재시도</p>
      </div>

      <div style={{ display: "flex", alignItems: "center", marginBottom: "1.25rem", overflowX: "auto", paddingBottom: 4 }}>
        {PHASES.map((p, i) => {
          const isDone = currentPhase === "done" || i < curIdx;
          const isActive = p.id === currentPhase;
          return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 64 }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, transition: "all .3s", background: isDone ? "#dcfce7" : isActive ? "#dbeafe" : "var(--color-background-secondary)", border: `1.5px solid ${isDone ? "#16a34a" : isActive ? "#2563eb" : "var(--color-border-secondary)"}`, color: isDone ? "#15803d" : isActive ? "#1d4ed8" : "var(--color-text-secondary)", boxShadow: isActive ? "0 0 0 3px rgba(37,99,235,.15)" : "none" }}>
                  {isDone ? "✓" : p.icon}
                </div>
                <span style={{ fontSize: 10, marginTop: 4, color: isDone ? "#16a34a" : isActive ? "#1d4ed8" : "var(--color-text-secondary)", fontWeight: isActive ? 600 : 400, textAlign: "center", lineHeight: 1.3, maxWidth: 56 }}>{p.label}</span>
              </div>
              {i < PHASES.length - 1 && <div style={{ width: 16, height: 1.5, background: i < curIdx ? "#16a34a" : "var(--color-border-tertiary)", flexShrink: 0, marginTop: -12 }} />}
            </div>
          );
        })}
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
          {[["upload","⬆ 파일 등록"],["progress","◎ 분석 진행"],["settings","⚙ 설정"]].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ padding: "10px 14px", fontSize: 12, fontWeight: tab === id ? 600 : 400, color: tab === id ? "#1d4ed8" : "var(--color-text-secondary)", background: "none", border: "none", borderBottom: tab === id ? "2px solid #2563eb" : "2px solid transparent", cursor: "pointer", whiteSpace: "nowrap" }}>{label}</button>
          ))}
        </div>

        <div style={{ padding: "1.25rem" }}>
          {tab === "upload" && (
            <div>
              <div onDrop={onDrop} onDragOver={(e) => e.preventDefault()} onClick={() => fileInput.current.click()}
                style={{ border: "1.5px dashed var(--color-border-secondary)", borderRadius: 8, padding: "1.75rem", textAlign: "center", cursor: "pointer", background: "var(--color-background-secondary)" }}>
                <div style={{ fontSize: 28, marginBottom: 6 }}>📄</div>
                <p style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", margin: "0 0 4px" }}>재무제표 파일을 클릭하거나 드래그하여 업로드</p>
                <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>PDF · JPG · PNG — 다중 파일 가능</p>
              </div>
              <input ref={fileInput} type="file" multiple accept=".pdf,.jpg,.jpeg,.png" style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
              {files.length > 0 && (
                <div style={{ marginTop: "1rem", display: "flex", flexDirection: "column", gap: 6 }}>
                  {files.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)" }}>
                      <span style={{ fontSize: 14 }}>📋</span>
                      <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        {["subject","related"].map((t) => (
                          <button key={t} onClick={() => setFiles((prev) => prev.map((x, j) => j === i ? { ...x, type: t } : x))}
                            style={{ padding: "3px 8px", fontSize: 11, fontWeight: f.type === t ? 600 : 400, borderRadius: 999, border: `1px solid ${f.type === t ? TAG[t].color : "var(--color-border-secondary)"}`, background: f.type === t ? TAG[t].bg : "transparent", color: f.type === t ? TAG[t].color : "var(--color-text-secondary)", cursor: "pointer" }}>
                            {TAG[t].label}
                          </button>
                        ))}
                      </div>
                      <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "var(--color-text-secondary)", cursor: "pointer", fontSize: 14, padding: 2 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              {files.length > 0 && (
                <div style={{ display: "flex", gap: 8, marginTop: "1rem", alignItems: "center" }}>
                  <button onClick={startAnalysis} disabled={running}
                    style={{ padding: "9px 20px", background: running ? "var(--color-border-secondary)" : "#1e3a5f", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: running ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                    {running ? <span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid rgba(255,255,255,.3)", borderTop: "2px solid #fff", borderRadius: "50%", animation: "spin .7s linear infinite" }} /> : "▶"}
                    {running ? "분석 진행 중..." : "심사 시작"}
                  </button>
                  <button onClick={reset} style={{ padding: "9px 14px", background: "none", border: "0.5px solid var(--color-border-secondary)", borderRadius: 8, fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" }}>초기화</button>
                  <span style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>{files.length}개 파일</span>
                </div>
              )}
            </div>
          )}

          {tab === "progress" && (
            <div>
              {!running && !done && logs.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem", color: "var(--color-text-secondary)" }}>
                  <div style={{ fontSize: 32, marginBottom: 8, opacity: .3 }}>◎</div>
                  <p style={{ fontSize: 13 }}>파일을 등록하고 심사를 시작하면<br />진행 상황이 표시됩니다</p>
                </div>
              ) : (
                <>
                  <div style={{ marginBottom: "1rem" }}>
                    <div style={{ background: "var(--color-background-secondary)", borderRadius: 999, height: 4, overflow: "hidden", marginBottom: 6 }}>
                      <div style={{ height: 4, borderRadius: 999, background: done ? "#16a34a" : "#2563eb", width: progress + "%", transition: "width .5s ease" }} />
                    </div>
                    <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: 0 }}>{done ? "✅ 전 단계 완료" : `진행률 ${progress}%`}</p>
                  </div>
                  <div ref={logRef} style={{ background: "var(--color-background-secondary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 8, padding: "10px 12px", maxHeight: 150, overflowY: "auto", marginBottom: "1rem" }}>
                    {logs.map((l, i) => (
                      <div key={i} style={{ fontSize: 11.5, lineHeight: 1.8, fontFamily: "monospace", color: l.type === "ok" ? "#15803d" : l.type === "active" ? "#1d4ed8" : l.type === "system" ? "#92400e" : l.type === "error" ? "#dc2626" : "var(--color-text-secondary)" }}>
                        {l.msg}
                      </div>
                    ))}
                  </div>
                  {stats && (
                    <div style={{ display: "flex", gap: 8, marginBottom: "1rem", flexWrap: "wrap" }}>
                      {[
                        { k: "실행 시간", v: `${stats.sec}초` },
                        { k: "API 호출", v: `${stats.calls}회` },
                        { k: "토큰 합계", v: stats.total.toLocaleString() },
                        { k: "입력 / 출력", v: `${stats.inTok.toLocaleString()} / ${stats.outTok.toLocaleString()}` },
                      ].map((s, i) => (
                        <div key={i} style={{ flex: "1 1 auto", minWidth: 120, padding: "8px 12px", background: "#f0f6ff", border: "0.5px solid #bfdbfe", borderRadius: 8 }}>
                          <p style={{ fontSize: 10, color: "#3b82f6", margin: 0 }}>{s.k}</p>
                          <p style={{ fontSize: 13, fontWeight: 700, color: "#1e3a5f", margin: "2px 0 0" }}>{s.v}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {results.map((r, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: "var(--color-background-secondary)", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)" }}>
                        <span style={{ fontSize: 13, color: r.ok ? "#16a34a" : "#dc2626" }}>{r.ok ? "✓" : "✕"}</span>
                        <span style={{ flex: 1, fontSize: 12, color: "var(--color-text-primary)" }}>{r.label}</span>
                        <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: r.ok ? "#dcfce7" : "#fee2e2", color: r.ok ? "#166534" : "#991b1b", fontWeight: 500 }}>{r.ok ? "완료" : "일부오류"}</span>
                      </div>
                    ))}
                  </div>
                  {done && report && (
                    <div style={{ marginTop: 14, padding: "14px 16px", background: "#f0f6ff", border: "1px solid #bfdbfe", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 600, color: "#1e3a5f", margin: "0 0 2px" }}>✦ 동적 통합보고서가 준비되었습니다</p>
                        <p style={{ fontSize: 11, color: "#3b82f6", margin: 0 }}>상세 분석 결과 열람 및 HTML 다운로드 가능</p>
                      </div>
                      <button onClick={() => setShowReport(true)}
                        style={{ padding: "9px 18px", background: "#1e3a5f", color: "#fff", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                        보고서 열람
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {tab === "settings" && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {[
                { key: "includeRelated", label: "관계기업 분석 포함", sub: "관계기업 파일이 있을 때 3단계 리스크 전이 분석 수행" },
                { key: "includeIndustry", label: "업종 비교 분석", sub: "산업 평균 대비 비교 관점 반영 (참고용)" },
              ].map((s) => (
                <div key={s.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                  <div><p style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-primary)", margin: 0 }}>{s.label}</p><p style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: "2px 0 0" }}>{s.sub}</p></div>
                  <div onClick={() => setSettings((p) => ({ ...p, [s.key]: !p[s.key] }))}
                    style={{ width: 36, height: 20, borderRadius: 999, background: settings[s.key] ? "#1e3a5f" : "var(--color-border-secondary)", position: "relative", cursor: "pointer", transition: "background .2s", flexShrink: 0 }}>
                    <div style={{ position: "absolute", top: 3, left: settings[s.key] ? 17 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left .2s" }} />
                  </div>
                </div>
              ))}
              <p style={{ fontSize: 11, color: "var(--color-text-secondary)", margin: "12px 0 0", lineHeight: 1.7 }}>
                ※ 재무제표 파일은 추출 단계에서 한 번만 전송합니다. 이후 분석은 BS·IS·CF·지표를 분리 저장한 뒤 각 단계에 필요한 데이터만 선택적으로 전달해 입력 토큰을 절감합니다. issue 항목은 섹션 단위로 1회 배치 호출로 처리하며, 오류 시 자동 재시도합니다.
              </p>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
