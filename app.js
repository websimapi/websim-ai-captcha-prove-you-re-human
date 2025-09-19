import { formatTime, sha256Hex, shuffle } from "utils";

const ROUNDS = 3;
let state = {
  round: 0,
  score: 0,
  startTime: 0,
  perRoundTimes: [],
  current: null, // {instruction, items:[{url, kind}], correctIndex, seeds}
  history: [],   // store puzzle summaries for proof hash
  lastHashHex: null, // add hash for posting
};

const els = {
  start: document.getElementById("screen-start"),
  puzzle: document.getElementById("screen-puzzle"),
  result: document.getElementById("screen-result"),
  btnStart: document.getElementById("btn-start"),
  btnSkip: document.getElementById("btn-skip"),
  gallery: document.getElementById("gallery"),
  instruction: document.getElementById("instruction"),
  loader: document.getElementById("loader"),
  round: document.getElementById("round-indicator"),
  timer: document.getElementById("timer"),
  scoreline: document.getElementById("scoreline"),
  btnDownload: document.getElementById("btn-download"),
  btnRetry: document.getElementById("btn-retry"),
  proofCanvas: document.getElementById("proof-canvas"),
  btnPost: document.getElementById("btn-post"),
  postStatus: document.getElementById("post-status"),
};

let timerHandle = null;
function startTimer() {
  const base = Date.now();
  state.startTime = base;
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const elapsed = Date.now() - base + state.perRoundTimes.reduce((a,b)=>a+b,0);
    els.timer.textContent = formatTime(elapsed);
  }, 250);
}
function stopTimerRound(roundStart) {
  const elapsed = Date.now() - roundStart;
  state.perRoundTimes.push(elapsed);
}

function showScreen(name) {
  [els.start, els.puzzle, els.result].forEach(s => s.classList.remove("active"));
  if (name === "start") els.start.classList.add("active");
  if (name === "puzzle") els.puzzle.classList.add("active");
  if (name === "result") els.result.classList.add("active");
}
function setLoading(on) {
  els.loader.style.display = on ? "flex" : "none";
  els.gallery.style.pointerEvents = on ? "none" : "auto";
}

async function getPuzzleSpec() {
  // Ask the model to craft a very specific, human-favored visual rule
  const sys = `Respond ONLY with JSON following this schema:
{
  "theme": string,            // short, e.g., "kitchen objects, overhead"
  "instruction": string,      // e.g., "Pick the image with an egg cracked OPEN on a wooden table, yolk visible."
  "target_prompt": string,    // full prompt for the correct image
  "decoys": [string, string]  // two different prompts that are close but wrong in a subtle way
}
Rules:
- Avoid text-in-image.
- Use concrete, human-favored cues: EXACT counts (e.g., exactly 3), LEFT/RIGHT orientation, ADJACENCY ("next to", "touching"), STATE ("peeled", "cracked open"), and COMPOSITION ("stacked 3-high", "one item upside down").
- Include at least two constraints combined (e.g., count + orientation, or state + adjacency).
- Make the correct image unambiguous for humans; make decoys plausible but violating ONE critical constraint each.
- Keep to everyday objects in simple scenes; prefer overhead or straight-on views; natural lighting.
- Output short, precise prompts suitable for photorealistic generation; no text or watermarks.`;
  const ideas = [
    "cutlery: exact count of forks vs spoons",
    "fruit: sliced vs whole, seeds visible",
    "shadows: light from right vs left",
    "containers: lid on vs off",
    "paper planes: nose up vs down",
    "socks: striped vs solid, odd pair",
    "books: stacked vs standing, one open",
    "sandwich: toothpick skewered vs not",
  ];
  const user = `Create a unique 3-image puzzle around: ${ideas[Math.floor(Math.random()*ideas.length)]}`;
  try {
    const completion = await websim.chat.completions.create({
      messages: [
        { role: "system", content: sys },
        { role: "user", content: [{ type: "text", text: user }] },
      ],
      json: true,
    });
    const data = JSON.parse(completion.content);
    if (!data || !data.instruction || !data.target_prompt || !Array.isArray(data.decoys)) throw new Error("bad schema");
    return data;
  } catch {
    // Fallback static spec
    return {
      theme: "mugs on a table",
      instruction: "Pick the image with a white mug filled to the brim, handle on the LEFT, teaspoon inside.",
      target_prompt: "photograph of a white ceramic mug, filled to brim, handle clearly on the left side, teaspoon inside the mug, on a wooden table, soft morning light, realistic",
      decoys: [
        "photograph of a white ceramic mug, half-filled, handle on the right, no spoon, wooden table, soft light, realistic",
        "photograph of a white ceramic mug, empty, handle on the left, spoon next to it, wooden table, soft light, realistic"
      ]
    };
  }
}

async function generatePuzzle() {
  setLoading(true);
  els.gallery.innerHTML = "";
  const roundStart = Date.now();
  const spec = await getPuzzleSpec();
  els.instruction.textContent = spec.instruction;

  // Seeds improve verifiability and allow hashing for proof
  const seeds = [Math.floor(Math.random()*1e6), Math.floor(Math.random()*1e6), Math.floor(Math.random()*1e6)];
  const reqs = [
    { kind: "target", prompt: spec.target_prompt, seed: seeds[0] },
    { kind: "decoy", prompt: spec.decoys[0], seed: seeds[1] },
    { kind: "decoy", prompt: spec.decoys[1], seed: seeds[2] },
  ];

  // Generate images in parallel
  const tasks = reqs.map(r => websim.imageGen({
    prompt: r.prompt,
    aspect_ratio: "4:3",
    seed: r.seed,
  }).then(res => ({ ...r, url: res.url })));

  let items = await Promise.all(tasks);

  // Shuffle for display
  items = shuffle(items);
  const correctIndex = items.findIndex(i => i.kind === "target");

  els.gallery.innerHTML = "";
  items.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = "card";
    const btn = document.createElement("button");
    btn.setAttribute("aria-label", `Image option ${idx+1}`);
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = idx + 1;
    const img = document.createElement("img");
    img.alt = `Option ${idx+1}`;
    img.src = item.url;
    btn.appendChild(img);
    card.appendChild(btn);
    card.appendChild(badge);
    els.gallery.appendChild(card);

    btn.addEventListener("click", () => {
      stopTimerRound(roundStart);
      const isCorrect = idx === correctIndex;
      if (isCorrect) state.score += 1;
      state.history.push({
        round: state.round,
        correct: isCorrect,
        targetSeed: items[correctIndex].seed,
        choiceIndex: idx,
      });
      nextRound();
    });
  });

  state.current = { instruction: spec.instruction, items, correctIndex, seeds };
  setLoading(false);
}

function reset() {
  state = { round: 0, score: 0, startTime: 0, perRoundTimes: [], current: null, history: [] };
  els.round.textContent = `Round 1/${ROUNDS}`;
  els.timer.textContent = "00:00";
}

async function nextRound() {
  state.round += 1;
  if (state.round >= ROUNDS) {
    clearInterval(timerHandle);
    await showResult();
    return;
  }
  els.round.textContent = `Round ${state.round+1}/${ROUNDS}`;
  await generatePuzzle();
}

function drawProofCanvas(hashHex) {
  const c = els.proofCanvas;
  const ctx = c.getContext("2d");
  // background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);

  // Title
  ctx.fillStyle = "#0a0a0a";
  ctx.font = "700 38px 'Noto Sans', sans-serif";
  ctx.fillText("HumanCheck — Proof of Humanity", 36, 70);

  // Score and time
  const totalMs = state.perRoundTimes.reduce((a,b)=>a+b,0);
  ctx.font = "600 22px 'Noto Sans', sans-serif";
  ctx.fillText(`Score: ${state.score}/${ROUNDS}`, 36, 120);
  ctx.fillText(`Total time: ${formatTime(totalMs)}`, 36, 152);

  // Rounds detail
  ctx.font = "600 18px 'Noto Sans', sans-serif";
  ctx.fillText("Rounds:", 36, 190);
  ctx.font = "400 16px 'Noto Sans', sans-serif";
  state.history.forEach((h, i) => {
    const y = 220 + i * 26;
    const txt = `#${i+1} — ${h.correct ? "✓ correct" : "✗ wrong"} — targetSeed:${h.targetSeed} — choice:${h.choiceIndex+1}`;
    ctx.fillText(txt, 48, y);
  });

  // Hash
  ctx.font = "600 18px 'Noto Sans', sans-serif";
  ctx.fillText("Verification Hash (SHA-256):", 36, 320);
  ctx.font = "400 14px 'Space Mono', monospace";
  const lines = hashHex.match(/.{1,64}/g) || [hashHex];
  lines.forEach((ln, i) => ctx.fillText(ln, 36, 346 + i * 20));

  // Footer
  ctx.font = "400 12px 'Noto Sans', sans-serif";
  ctx.fillStyle = "#6b6b6b";
  ctx.fillText(new Date().toISOString(), 36, c.height - 28);
  ctx.fillText("Keep this image as your proof. Do not crop.", 36, c.height - 10);
}

async function showResult() {
  showScreen("result");
  els.scoreline.textContent = `Score: ${state.score}/${ROUNDS}`;

  // Build a verifiable string: timestamp + seeds + outcomes
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    score: state.score,
    rounds: state.history,
  });
  const hashHex = await sha256Hex(payload);
  state.lastHashHex = hashHex;
  drawProofCanvas(hashHex);
}

els.btnStart.addEventListener("click", async () => {
  reset();
  showScreen("puzzle");
  startTimer();
  await generatePuzzle();
});

els.btnSkip.addEventListener("click", async () => {
  // Skipping counts as wrong and advances the round
  state.history.push({
    round: state.round,
    correct: false,
    targetSeed: state.current?.items?.[state.current.correctIndex]?.seed ?? null,
    choiceIndex: -1,
  });
  nextRound();
});

els.btnRetry.addEventListener("click", () => {
  showScreen("start");
});

els.btnDownload.addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = `humancheck-proof-${Date.now()}.png`;
  link.href = els.proofCanvas.toDataURL("image/png");
  link.click();
});

// Keyboard accessibility: 1/2/3 selects images
window.addEventListener("keydown", (e) => {
  if (!els.puzzle.classList.contains("active")) return;
  const key = e.key;
  const idx = ["1","2","3"].indexOf(key);
  if (idx >= 0) {
    const btn = els.gallery.querySelectorAll("button")[idx];
    if (btn) btn.click();
  }
});

// Initialize
showScreen("start");

async function postProofToComments() {
  try {
    els.postStatus.textContent = "Preparing proof image…";
    const blob = await new Promise(res => els.proofCanvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Failed to render image");
    const file = new File([blob], `humancheck-proof-${Date.now()}.png`, { type: "image/png" });
    const url = await window.websim.upload(file);

    const totalMs = state.perRoundTimes.reduce((a,b)=>a+b,0);
    const content = [
      "HumanCheck proof",
      `Score: ${state.score}/${ROUNDS}`,
      `Total time: ${formatTime(totalMs)}`,
      `Hash: ${state.lastHashHex?.slice(0,16)}…`
    ].join(" • ");

    els.postStatus.textContent = "Opening comment editor…";
    const once = (fn) => {
      const handler = (e) => { window.websim.removeEventListener('comment:created', handler); fn(e); };
      window.websim.addEventListener('comment:created', handler);
    };
    once(() => { els.postStatus.textContent = "Posted! Check the comments."; });

    const res = await window.websim.postComment({ content, images: [url] });
    if (res && res.error) throw new Error(res.error);
  } catch (err) {
    els.postStatus.textContent = `Failed to post: ${err.message || err}`;
  }
}

els.btnPost.addEventListener("click", () => {
  if (!els.result.classList.contains("active")) return;
  postProofToComments();
});