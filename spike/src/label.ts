// Tap labeler: SPACE marks the end of the current word at audio.currentTime, BACKSPACE undoes.
import { baseName, downloadJson, el, errorMessage, fetchDisplayWords, makeStatus, renderWords } from "./common";
import { WORD_COUNT } from "./fatiha";
import { parseLabels, type Labels } from "./labels";

const fileInput = el<HTMLInputElement>("file");
const rateSelect = el<HTMLSelectElement>("rate");
const playButton = el<HTMLButtonElement>("play");
const undoButton = el<HTMLButtonElement>("undo");
const downloadButton = el<HTMLButtonElement>("download");
const audio = el<HTMLAudioElement>("audio");
const statusLine = el<HTMLDivElement>("status");
const wordsBox = el<HTMLDivElement>("words");
const marksLine = el<HTMLParagraphElement>("marks");

let words: string[] | null = null;
let wordNodes: HTMLSpanElement[] = [];
let recordingName: string | null = null;
let objectUrl: string | null = null;
const wordEnds: number[] = [];

const setStatus = makeStatus(statusLine);

function refresh(): void {
  wordNodes.forEach((node, index) => {
    node.classList.toggle("matched", index < wordEnds.length);
    node.classList.toggle("target", index === wordEnds.length);
  });
  const done = wordEnds.length === WORD_COUNT;
  undoButton.disabled = wordEnds.length === 0;
  downloadButton.disabled = !done;
  marksLine.textContent = wordEnds.map((t, i) => `${i + 1}: ${t.toFixed(3)}s`).join("   ");
  if (recordingName === null) return;
  setStatus(
    done
      ? "اكتملت الكلمات التسع والعشرون. نزّل الملف."
      : `الكلمة ${wordEnds.length + 1} من ${WORD_COUNT}: اضغط Space عند نهايتها.`,
  );
}

function mark(): void {
  if (recordingName === null || wordEnds.length >= WORD_COUNT) return;
  const time = audio.currentTime;
  const last = wordEnds[wordEnds.length - 1];
  if (last !== undefined && time <= last) {
    setStatus(`الزمن ${time.toFixed(3)}s ليس بعد العلامة السابقة (${last.toFixed(3)}s). تراجع أو أكمل التشغيل.`, true);
    return;
  }
  wordEnds.push(time);
  refresh();
}

function undo(): void {
  if (wordEnds.pop() !== undefined) refresh();
}

/** Validated labels for the current marks. Throws parseLabels' bilingual message when invalid. */
function buildLabels(): Labels {
  if (recordingName === null) throw new Error("لم يُختر تسجيل / no recording selected");
  const rate = Number(audio.playbackRate).toFixed(2);
  return parseLabels({
    recording: recordingName,
    wordEnds,
    notes: `tap-labelled with playback rate ${rate}x; reaction-time bias not corrected`,
  });
}

function download(): void {
  if (recordingName === null) return;
  try {
    const labels = buildLabels();
    downloadJson(`${baseName(recordingName)}.labels.json`, labels);
    setStatus(`تم تنزيل ${baseName(recordingName)}.labels.json`);
  } catch (err) {
    const text = errorMessage(err);
    console.error("[spike] labels invalid", text);
    setStatus(text, true);
  }
}

function loadFile(file: File): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  audio.src = objectUrl;
  audio.playbackRate = Number(rateSelect.value);
  recordingName = file.name;
  wordEnds.length = 0;
  playButton.disabled = false;
  refresh();
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  loadFile(file);
  fileInput.blur();
});

rateSelect.addEventListener("change", () => {
  audio.playbackRate = Number(rateSelect.value);
  rateSelect.blur();
});

playButton.addEventListener("click", () => {
  if (audio.paused) {
    audio.play().catch((err: unknown) => {
      console.error("[spike] playback failed", errorMessage(err));
      setStatus(`Playback failed: ${errorMessage(err)}`, true);
    });
  } else audio.pause();
  playButton.blur();
});
undoButton.addEventListener("click", undo);
downloadButton.addEventListener("click", download);

document.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    if (!event.repeat) mark();
  } else if (event.code === "Backspace") {
    event.preventDefault();
    undo();
  }
});

wordNodes = renderWords(wordsBox, words);
fetchDisplayWords()
  .then((loaded) => {
    words = loaded;
    wordNodes = renderWords(wordsBox, words);
    refresh();
  })
  .catch((err: unknown) => {
    // Labeling still works with word numbers when the corpus is missing.
    console.error("[spike] corpus error", err);
  });

if (import.meta.env.DEV) {
  // Dev-server only: pick recordings from spike/recordings and save labels back to that folder.
  void import("./dev/label-dev").then((m) =>
    m.initLabelDev({
      controls: document.querySelector<HTMLElement>(".controls") ?? document.body,
      loadFile,
      buildLabels,
      getRecordingName: () => recordingName,
      setStatus,
    }),
  );
}
