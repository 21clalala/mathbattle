const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";

// ── Supabase (REST API 직접 호출, 추가 패키지 불필요) ──
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SB_ON = !!(SB_URL && SB_KEY);
// 지난 기록 보기 잠금 비밀번호
const HISTORY_PASSWORD = process.env.HISTORY_PASSWORD || "";

async function sbFetch(pathAndQuery, options) {
  const r = await fetch(SB_URL + "/rest/v1/" + pathAndQuery, Object.assign({
    headers: Object.assign({
      "apikey": SB_KEY,
      "Authorization": "Bearer " + SB_KEY,
      "Content-Type": "application/json",
    }, (options && options.headers) || {}),
  }, options || {}));
  if (!r.ok) throw new Error("Supabase " + r.status + " " + (await r.text()).slice(0, 300));
  const txt = await r.text();
  return txt ? JSON.parse(txt) : null;
}
// 수업 저장(있으면 갱신)
async function sbSaveSession(s) {
  if (!SB_ON) return;
  try {
    await sbFetch("sessions", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({
        code: s.code, problem_text: s.problemText, problem_image: s.problemImage,
        answer_text: s.answerText, answer_graph: s.answerGraph,
      }),
    });
  } catch (e) { console.error("[sb session]", e.message); }
}
// 제출 저장(같은 code+student_id면 갱신)
async function sbSaveSubmission(code, x) {
  if (!SB_ON) return;
  try {
    await sbFetch("submissions?on_conflict=code,student_id", {
      method: "POST",
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({
        code, student_id: x.studentId, name: x.name, verdict: x.verdict,
        score: x.score, ok_count: x.okCount, total: x.total, summary: x.summary,
        strength: x.strength, features: x.features, correct_solution: x.correctSolution,
        image: x.image, submitted_at: new Date(x.submittedAt).toISOString(),
      }),
    });
  } catch (e) { console.error("[sb submission]", e.message); }
}

const sessions = new Map();

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  let c = "";
  for (let i = 0; i < 4; i++) c += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return c;
}

async function callClaude(content, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error("Anthropic " + r.status + " " + (await r.text()).slice(0, 300));
  const data = await r.json();
  const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return JSON.parse(txt.replace(/```json|```/g, "").trim());
}

function imgBlock(dataUrl) {
  const mime = (dataUrl.match(/^data:([^;]+);/) || [])[1] || "image/jpeg";
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  return { type: "image", source: { type: "base64", media_type: mime, data: base64 } };
}

async function buildAnswerGraph(s) {
  if (!API_KEY) return null;
  const content = [];
  let text = "아래 정보를 보고, 이 문제가 '함수의 그래프 개형을 그리는 문제'인지 판단하세요. 고등학교 수학 수준입니다.\n\n[문제]\n";
  if (s.problemImage) { content.push(imgBlock(s.problemImage)); text += "(위 이미지가 문제입니다)\n"; }
  if (s.problemText) text += s.problemText + "\n";
  if (s.answerText) text += "\n[정답 함수/모범답안 메모]\n" + s.answerText + "\n";
  if (s.answerImage) { content.push(imgBlock(s.answerImage)); text += "\n(위 이미지가 선생님의 모범답안입니다)\n"; }
  text += "\n그래프 개형을 그리는 문제이고 y=f(x) 형태로 그릴 수 있으면, 정답 함수를 정하고 점들을 촘촘히(40~120개) 계산하세요. 정의역 안에서 의미 있는 x범위를 잡고, 극값/절편/변곡점 등 핵심점도 표시하세요.\n그래프를 그리는 문제가 아니거나(일반 계산·증명·서술형 등), 정적분 값·수열의 합처럼 곡선이 아니면 drawable을 false로 하세요. 억지로 그래프를 만들지 마세요.\n\n반드시 아래 JSON만 출력(마크다운 금지):\n{\n \"drawable\": true,\n \"funcLabel\": \"y = x ln x\",\n \"domainNote\": \"x > 0\",\n \"points\": [{\"x\": 0.1, \"y\": -0.23}],\n \"keyPoints\": [{\"x\": 0.37, \"y\": -0.37, \"label\": \"극소\"}],\n \"note\": \"한 줄 설명(한국어)\"\n}\n그릴 수 없으면: {\"drawable\": false, \"note\": \"이유(한국어)\"}";
  content.push({ type: "text", text });
  try {
    const g = await callClaude(content, 3000);
    if (g && g.drawable && Array.isArray(g.points) && g.points.length > 1) return g;
    return { drawable: false, note: (g && g.note) || "그래프를 그릴 수 없는 형태입니다." };
  } catch (e) {
    console.error("[graph error]", e.message);
    return null;
  }
}

app.post("/api/sessions", async (req, res) => {
  const { problemText, problemImage, answerText, answerImage } = req.body || {};
  if (!problemText && !problemImage)
    return res.status(400).json({ error: "문제를 사진으로 올리거나 글로 입력해 주세요." });
  let code;
  do { code = makeCode(); } while (sessions.has(code));
  const s = {
    code,
    problemText: (problemText || "").trim().slice(0, 1500),
    problemImage: problemImage || null,
    answerText: (answerText || "").trim().slice(0, 1500),
    answerImage: answerImage || null,
    createdAt: Date.now(),
    submissions: new Map(),
    answerGraph: null,
  };
  sessions.set(code, s);
  s.answerGraph = await buildAnswerGraph(s);
  await sbSaveSession(s);
  res.json({ code });
});

app.get("/api/sessions/:code", (req, res) => {
  const s = sessions.get((req.params.code || "").toUpperCase());
  if (!s) return res.status(404).json({ error: "세션을 찾을 수 없어요. 코드를 확인해 주세요." });
  res.json({ problemText: s.problemText, problemImage: s.problemImage });
});

app.post("/api/sessions/:code/submit", async (req, res) => {
  const s = sessions.get((req.params.code || "").toUpperCase());
  if (!s) return res.status(404).json({ error: "세션을 찾을 수 없어요." });
  if (!API_KEY) return res.status(500).json({ error: "서버에 API 키가 설정되지 않았어요." });
  const { studentId, name, image } = req.body || {};
  if (!studentId || !name || !image)
    return res.status(400).json({ error: "학번, 이름, 사진이 모두 필요해요." });
  try {
    const result = await grade(s, image);
    const features = Array.isArray(result.features) ? result.features : [];
    const okCount = features.filter((f) => f && f.ok).length;
    const score = features.length ? Math.round((100 * okCount) / features.length) : 0;
    const sub = {
      studentId: String(studentId).trim().slice(0, 20),
      name: String(name).trim().slice(0, 30),
      verdict: result.verdict || "unclear",
      score, okCount, total: features.length,
      summary: result.summary || "", features,
      strength: result.strength || "",
      correctSolution: result.correctSolution || "",
      image, submittedAt: Date.now(),
    };
    s.submissions.set(sub.studentId, sub);
    await sbSaveSubmission(s.code, sub);
    res.json({
      verdict: sub.verdict, score, okCount, total: sub.total,
      summary: sub.summary, features: sub.features,
      strength: sub.strength,
      correctSolution: sub.correctSolution, answerGraph: s.answerGraph,
    });
  } catch (e) {
    console.error("[grade error]", e.message);
    res.status(500).json({ error: "채점 중 오류가 발생했어요. 사진이 선명한지 확인하고 다시 시도해 주세요." });
  }
});

app.get("/api/sessions/:code/leaderboard", (req, res) => {
  const s = sessions.get((req.params.code || "").toUpperCase());
  if (!s) return res.status(404).json({ error: "세션 없음" });
  const list = [...s.submissions.values()].map((x) => ({
    studentId: x.studentId, name: x.name, verdict: x.verdict,
    score: x.score, okCount: x.okCount, total: x.total,
    summary: x.summary, strength: x.strength, submittedAt: x.submittedAt,
  }));
  list.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
  res.json({ problemText: s.problemText, problemImage: s.problemImage, count: list.length, leaderboard: list });
});

app.get("/api/sessions/:code/submission/:studentId", (req, res) => {
  const s = sessions.get((req.params.code || "").toUpperCase());
  if (!s) return res.status(404).json({ error: "세션 없음" });
  const x = s.submissions.get(req.params.studentId);
  if (!x) return res.status(404).json({ error: "제출 없음" });
  res.json(Object.assign({}, x, { answerGraph: s.answerGraph }));
});

// CSV 내려받기 — 선생님
function csvCell(v) {
  const str = v == null ? "" : String(v);
  return '"' + str.replace(/"/g, '""') + '"';
}
app.get("/api/sessions/:code/csv", (req, res) => {
  const s = sessions.get((req.params.code || "").toUpperCase());
  if (!s) return res.status(404).send("세션 없음");
  const list = [...s.submissions.values()];
  list.sort((a, b) => b.score - a.score || a.submittedAt - b.submittedAt);
  const head = ["순위", "학번", "이름", "점수", "판정", "정답항목", "전체항목", "강점요약", "채점요약", "제출시각"];
  const verdictKo = { correct: "정답", incorrect: "오답", partial: "부분", unclear: "판독" };
  const rows = list.map((x, i) => [
    i + 1, x.studentId, x.name, x.score, verdictKo[x.verdict] || x.verdict,
    x.okCount, x.total, x.strength || "", x.summary || "",
    new Date(x.submittedAt).toLocaleString("ko-KR"),
  ].map(csvCell).join(","));
  const csv = "\uFEFF" + [head.map(csvCell).join(","), ...rows].join("\r\n"); // BOM for Excel 한글
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="mathbattle_' + s.code + '.csv"');
  res.send(csv);
});

// ── 지난 기록 보기 (선생님 전용, 비밀번호 잠금) ──
function checkPassword(req, res) {
  if (!HISTORY_PASSWORD) { res.status(503).json({ error: "기록 보기 비밀번호가 서버에 설정되지 않았어요." }); return false; }
  const pw = req.get("x-history-password") || req.query.pw || "";
  if (pw !== HISTORY_PASSWORD) { res.status(401).json({ error: "비밀번호가 올바르지 않아요." }); return false; }
  return true;
}
// 지난 수업 목록
app.get("/api/history/sessions", async (req, res) => {
  if (!checkPassword(req, res)) return;
  if (!SB_ON) return res.status(503).json({ error: "데이터베이스가 연결되지 않았어요." });
  try {
    const list = await sbFetch("sessions?select=code,problem_text,created_at&order=created_at.desc&limit=200");
    res.json({ sessions: list || [] });
  } catch (e) { res.status(500).json({ error: "기록을 불러오지 못했어요." }); }
});
// 특정 수업의 제출 목록(채점 결과+사진)
app.get("/api/history/sessions/:code", async (req, res) => {
  if (!checkPassword(req, res)) return;
  if (!SB_ON) return res.status(503).json({ error: "데이터베이스가 연결되지 않았어요." });
  const code = (req.params.code || "").toUpperCase();
  try {
    const sess = await sbFetch("sessions?code=eq." + encodeURIComponent(code) + "&select=*");
    const subs = await sbFetch("submissions?code=eq." + encodeURIComponent(code) + "&select=*&order=score.desc,submitted_at.asc");
    res.json({ session: (sess && sess[0]) || null, submissions: subs || [] });
  } catch (e) { res.status(500).json({ error: "기록을 불러오지 못했어요." }); }
});
// 지난 수업 CSV
app.get("/api/history/sessions/:code/csv", async (req, res) => {
  if (!checkPassword(req, res)) return;
  if (!SB_ON) return res.status(503).send("DB 없음");
  const code = (req.params.code || "").toUpperCase();
  try {
    const subs = await sbFetch("submissions?code=eq." + encodeURIComponent(code) + "&select=*&order=score.desc,submitted_at.asc") || [];
    const head = ["순위", "학번", "이름", "점수", "판정", "정답항목", "전체항목", "강점요약", "채점요약", "제출시각"];
    const vk = { correct: "정답", incorrect: "오답", partial: "부분", unclear: "판독" };
    const rows = subs.map((x, i) => [
      i + 1, x.student_id, x.name, x.score, vk[x.verdict] || x.verdict,
      x.ok_count, x.total, x.strength || "", x.summary || "",
      new Date(x.submitted_at).toLocaleString("ko-KR"),
    ].map(csvCell).join(","));
    const csv = "\uFEFF" + [head.map(csvCell).join(","), ...rows].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="mathbattle_' + code + '.csv"');
    res.send(csv);
  } catch (e) { res.status(500).send("오류"); }
});

async function grade(s, studentImage) {
  const content = [];
  let text = "당신은 고등학교 수학(미적분 포함)을 가르치는 꼼꼼한 선생님입니다. 학생이 푼 답안 사진을 채점합니다. 문제는 그래프 개형을 그리는 문제일 수도, 일반적인 계산·증명·서술형 문제일 수도 있습니다.\n\n[문제]\n";
  if (s.problemImage) { content.push(imgBlock(s.problemImage)); text += "(위 첫 번째 이미지가 문제입니다)\n"; }
  if (s.problemText) text += s.problemText + "\n";
  if (s.answerText) text += "\n[모범답안/정답 메모]\n" + s.answerText + "\n";
  if (s.answerImage) { content.push(imgBlock(s.answerImage)); text += "\n(위 이미지는 선생님의 모범답안입니다. 이를 채점의 기준으로 삼으세요. 손으로 쓴 답안이면 표현 차이는 너그럽게 보되, 풀이 논리와 최종 답이 맞는지를 보세요)\n"; }
  if (!s.answerText && !s.answerImage)
    text += "\n모범답안이 제공되지 않았습니다. 문제를 직접 풀어 정답 기준을 세우세요.\n";
  content.push(imgBlock(studentImage));
  text += "\n위 마지막 이미지가 학생의 답안입니다. 다음 기준으로 문제 유형을 먼저 판단하고 채점하세요.\n\n" +
    "■ 문제가 '그래프 개형을 그리는 문제'라면: type을 \"graph\"로 하고, 핵심 특징(정의역, 절편, 극값의 위치·종류, 증감, 오목·볼록, 변곡점, 점근 거동 등)이 학생 그래프에 올바르게 반영됐는지 항목별(features)로 채점하세요. 손그림이므로 정확한 좌표값보다 특징이 맞는지를 봅니다.\n\n" +
    "■ 그 외 일반 계산·증명·서술형 문제라면: type을 \"calc\"로 하고, 풀이 단계와 최종 답이 맞는지를 단계별(features의 name을 '1단계: ...' 식으로)로 채점하거나, 핵심 채점 포인트별로 채점하세요. 최종 답이 맞는지 반드시 확인하세요.\n\n" +
    "공통: 모범답안이 있으면 그것을 기준으로 비교하세요. 틀린 부분은 어디서 왜 틀렸는지 짚고, 불분명하면 해당 항목 ok를 false로 두고 이유를 적으세요. strength에는 학생이 특히 잘한 점을 한 줄로 요약(없으면 빈 문자열)하세요.\n\n" +
    "수식 표기 규칙(중요): summary, features의 expected와 comment, correctSolution 안에서 수식·수학 기호는 반드시 LaTeX로 쓰고 달러기호로 감싸세요. 인라인은 $...$, 따로 떼는 식은 $$...$$. 예: $f'(x)=\\ln x+1$, $x=\\frac{1}{e}$, $\\int_0^1 x^2\\,dx=\\frac{1}{3}$, $\\lim_{x\\to0^+}$. 분수는 x/y 대신 $\\frac{x}{y}$, 거듭제곱은 x^2 대신 $x^2$로 쓰세요. 일반 한국어 설명은 달러기호 밖에 그대로 두세요.\n\n" +
    "반드시 아래 JSON만 출력(마크다운·백틱 금지):\n{\n \"type\": \"graph\" | \"calc\",\n \"verdict\": \"correct\" | \"incorrect\" | \"partial\" | \"unclear\",\n \"summary\": \"한두 문장 채점 요약(한국어)\",\n \"strength\": \"이 학생이 잘한 점 한 줄 요약(한국어)\",\n \"features\": [{\"name\":\"특징명 또는 단계명\",\"expected\":\"정답 기준\",\"ok\":true,\"comment\":\"한 줄 평(한국어)\"}],\n \"correctSolution\": \"올바른 풀이 또는 그래프 개형 설명(한국어)\"\n}";
  content.push({ type: "text", text });
  return callClaude(content, 2500);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("덕형 수학 배틀존 running on port " + PORT));
