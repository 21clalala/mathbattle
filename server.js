const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-4-6";

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
  let text = "아래 정보로 정답 그래프를 그릴 좌표 데이터를 만드세요. 고등학교 미적분 수준입니다.\n\n[문제]\n";
  if (s.problemImage) { content.push(imgBlock(s.problemImage)); text += "(위 이미지가 문제입니다)\n"; }
  if (s.problemText) text += s.problemText + "\n";
  if (s.answerText) text += "\n[정답 함수/모범답안 메모]\n" + s.answerText + "\n";
  if (s.answerImage) { content.push(imgBlock(s.answerImage)); text += "\n(위 이미지가 선생님의 모범답안입니다)\n"; }
  text += "\n이 문제의 정답 함수 y=f(x)를 정하고, 그래프를 그릴 수 있으면 점들을 촘촘히(40~120개) 계산하세요.\n가능하면 정의역 안에서 의미 있는 x범위를 잡고, 극값/절편/변곡점 등 핵심점도 표시하세요.\n정적분 값(상수)·수열의 합처럼 곡선이 아니면 drawable을 false로 하세요.\n\n반드시 아래 JSON만 출력(마크다운 금지):\n{\n \"drawable\": true,\n \"funcLabel\": \"y = x ln x\",\n \"domainNote\": \"x > 0\",\n \"points\": [{\"x\": 0.1, \"y\": -0.23}],\n \"keyPoints\": [{\"x\": 0.37, \"y\": -0.37, \"label\": \"극소\"}],\n \"note\": \"한 줄 설명(한국어)\"\n}\n그릴 수 없으면: {\"drawable\": false, \"note\": \"이유(한국어)\"}";
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

async function grade(s, studentImage) {
  const content = [];
  let text = "당신은 고등학교 미적분을 가르치는 꼼꼼한 수학 선생님입니다. 학생이 미분을 이용해 그린 그래프 개형(과 풀이) 사진을 채점합니다.\n\n[문제]\n";
  if (s.problemImage) { content.push(imgBlock(s.problemImage)); text += "(위 첫 번째 이미지가 문제입니다)\n"; }
  if (s.problemText) text += s.problemText + "\n";
  if (s.answerText) text += "\n[모범답안/정답 메모]\n" + s.answerText + "\n";
  if (s.answerImage) { content.push(imgBlock(s.answerImage)); text += "\n(위 이미지는 선생님의 모범답안입니다. 이를 채점 기준으로 삼되, 손그림 오차는 감안하세요)\n"; }
  if (!s.answerText && !s.answerImage)
    text += "\n모범답안이 제공되지 않았습니다. 문제를 미적분으로 직접 분석해 정답 기준을 세우세요: 정의역, 절편, 도함수로 구한 극값의 위치·종류, 증감, 이계도함수로 본 오목·볼록과 변곡점, 점근 거동.\n";
  content.push(imgBlock(studentImage));
  text += "\n위 마지막 이미지가 학생의 답안입니다. 각 핵심 특징이 학생 그래프에 올바르게 반영됐는지 항목별로 채점하세요.\n손으로 그린 개형이므로 정확한 좌표값보다 핵심 특징(정의역, 극값의 위치·종류, 증감, 오목·볼록, 변곡점, 점근 거동, 절편)이 맞는지를 봅니다. 사소한 오차는 너그럽게 보되 특징이 틀리면 지적하세요. 불분명하면 해당 항목 ok를 false로 두고 이유를 적으세요.\nstrength에는 이 학생이 특히 잘한 점을 한 줄로 요약하세요(예: '극값 위치와 오목·볼록을 정확히 잡고 점근 거동까지 반영함'). 잘한 점이 없으면 빈 문자열.\n\n반드시 아래 JSON만 출력(마크다운·백틱 금지):\n{\n \"verdict\": \"correct\" | \"incorrect\" | \"partial\" | \"unclear\",\n \"summary\": \"한두 문장 채점 요약(한국어)\",\n \"strength\": \"이 학생이 잘한 점 한 줄 요약(한국어)\",\n \"features\": [{\"name\":\"특징명\",\"expected\":\"정답 기준\",\"ok\":true,\"comment\":\"학생 그래프 한 줄 평(한국어)\"}],\n \"correctSolution\": \"미분을 이용한 올바른 분석과 그래프 개형 설명(한국어)\"\n}";
  content.push({ type: "text", text });
  return callClaude(content, 2500);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("덕형 수학 배틀존 running on port " + PORT));
