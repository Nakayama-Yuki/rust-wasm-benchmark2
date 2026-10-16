"use client";

import { useRef, useState } from "react";
import Link from "next/link";

const ITERATIONS = 420;
const ROUNDS = 3;

type WasmExports = {
  memory: WebAssembly.Memory;
  alloc: (length: number) => number;
  dealloc: (pointer: number, length: number) => void;
  render: (
    pointer: number,
    width: number,
    height: number,
    maxIterations: number,
  ) => number;
};

type BenchmarkResult = {
  jsMilliseconds: number;
  wasmMilliseconds: number;
  matching: boolean;
};

function isWasmExports(
  exports: WebAssembly.Exports,
): exports is WebAssembly.Exports & WasmExports {
  return (
    exports.memory instanceof WebAssembly.Memory &&
    typeof exports.alloc === "function" &&
    typeof exports.dealloc === "function" &&
    typeof exports.render === "function"
  );
}

const RESOLUTIONS = {
  "320x180": { width: 320, height: 180 },
  "640x360": { width: 640, height: 360 },
  "960x540": { width: 960, height: 540 },
} as const;

function renderJavaScript(
  output: Uint16Array,
  width: number,
  height: number,
): number {
  let checksum = 0;
  for (let py = 0; py < height; py += 1) {
    const imaginary = (py / height) * 2.4 - 1.2;
    for (let px = 0; px < width; px += 1) {
      const real = (px / width) * 3.5 - 2.5;
      let zr = 0;
      let zi = 0;
      let count = 0;
      while (zr * zr + zi * zi <= 4 && count < ITERATIONS) {
        const nextZr = zr * zr - zi * zi + real;
        zi = 2 * zr * zi + imaginary;
        zr = nextZr;
        count += 1;
      }
      const index = py * width + px;
      output[index] = count;
      checksum = (checksum + count) >>> 0;
    }
  }
  return checksum;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function formatTime(milliseconds: number): string {
  return milliseconds < 10 ? milliseconds.toFixed(2) : milliseconds.toFixed(1);
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wasmRef = useRef<WasmExports | null>(null);
  const [resolution, setResolution] =
    useState<keyof typeof RESOLUTIONS>("640x360");
  const [isRunning, setIsRunning] = useState(false);
  const [hasRendered, setHasRendered] = useState(false);
  const [status, setStatus] = useState("準備完了。ボタンを押して比較します。");
  const [result, setResult] = useState<BenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { width, height } = RESOLUTIONS[resolution];

  async function loadWasm(): Promise<WasmExports> {
    if (wasmRef.current) return wasmRef.current;

    const response = await fetch("/fractal_wasm.wasm");
    if (!response.ok) {
      throw new Error(
        "WebAssembly ファイルを読み込めません。public/fractal_wasm.wasm を確認してください。",
      );
    }

    const { instance } = await WebAssembly.instantiate(
      await response.arrayBuffer(),
      {},
    );
    if (!isWasmExports(instance.exports)) {
      throw new Error("WebAssembly モジュールに必要な関数がありません。");
    }
    const exports = instance.exports;
    wasmRef.current = exports;
    return exports;
  }

  function paintFractal(
    output: Uint16Array,
    renderWidth: number,
    renderHeight: number,
  ) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) {
      throw new Error("描画用 Canvas を準備できませんでした。");
    }

    canvas.width = renderWidth;
    canvas.height = renderHeight;
    const image = context.createImageData(renderWidth, renderHeight);
    const pixels = image.data;

    for (let index = 0; index < output.length; index += 1) {
      const count = output[index];
      const pixel = index * 4;
      if (count === ITERATIONS) {
        pixels[pixel] = 11;
        pixels[pixel + 1] = 24;
        pixels[pixel + 2] = 27;
      } else {
        const shade = Math.sqrt(count / ITERATIONS);
        pixels[pixel] = Math.round(35 + 210 * shade);
        pixels[pixel + 1] = Math.round(115 + 115 * (1 - shade));
        pixels[pixel + 2] = Math.round(133 + 75 * shade);
      }
      pixels[pixel + 3] = 255;
    }

    context.putImageData(image, 0, 0);
  }

  async function runBenchmark() {
    setIsRunning(true);
    setError(null);
    setResult(null);
    setStatus("WebAssembly を準備しています…");

    let wasm: WasmExports | null = null;
    let pointer = 0;
    let length = 0;

    try {
      wasm = await loadWasm();
      length = width * height;
      pointer = wasm.alloc(length);
      if (!pointer) {
        throw new Error("計算用メモリを確保できませんでした。");
      }
      const output = new Uint16Array(wasm.memory.buffer, pointer, length);

      setStatus("計測前のウォームアップ中…");
      renderJavaScript(output, width, height);
      wasm.render(pointer, width, height, ITERATIONS);

      const jsTimes: number[] = [];
      const wasmTimes: number[] = [];
      let jsChecksum = 0;
      let wasmChecksum = 0;

      for (let round = 0; round < ROUNDS; round += 1) {
        setStatus(`比較中… ${round + 1} / ${ROUNDS} 回`);
        await nextPaint();

        const timeJs = () => {
          const start = performance.now();
          jsChecksum = renderJavaScript(output, width, height);
          return performance.now() - start;
        };
        const timeWasm = () => {
          const start = performance.now();
          wasmChecksum = wasm!.render(pointer, width, height, ITERATIONS);
          return performance.now() - start;
        };

        if (round % 2 === 0) {
          jsTimes.push(timeJs());
          wasmTimes.push(timeWasm());
        } else {
          wasmTimes.push(timeWasm());
          jsTimes.push(timeJs());
        }
      }

      paintFractal(output, width, height);
      setHasRendered(true);
      setResult({
        jsMilliseconds: median(jsTimes),
        wasmMilliseconds: median(wasmTimes),
        matching: jsChecksum === wasmChecksum,
      });
      setStatus(
        jsChecksum === wasmChecksum ?
          `出力一致 · 各 ${ROUNDS} 回の中央値を表示`
        : "出力不一致 · 計算条件を確認してください",
      );
    } catch (caughtError) {
      console.error(caughtError);
      setError(
        caughtError instanceof Error ?
          caughtError.message
        : "計算中にエラーが発生しました。",
      );
      setStatus("計算を完了できませんでした。");
    } finally {
      if (wasm && pointer && length) {
        wasm.dealloc(pointer, length);
      }
      setIsRunning(false);
    }
  }

  const matching = result?.matching ?? true;
  const longest =
    result ? Math.max(result.jsMilliseconds, result.wasmMilliseconds) : 0;
  const ratio =
    result ?
      Math.max(result.jsMilliseconds, result.wasmMilliseconds) /
      Math.min(result.jsMilliseconds, result.wasmMilliseconds)
    : 0;

  let comparisonText = "同じ仕事を、ふたつの方法で。";
  let comparisonDetail = "まずは計算して結果を見てみましょう。";
  let comparisonMark = "↗";
  if (result && !result.matching) {
    comparisonText = "計算結果が一致しませんでした。";
    comparisonDetail = "時間の比較より、実行環境や出力をご確認ください。";
    comparisonMark = "!";
  } else if (
    result &&
    Math.abs(result.jsMilliseconds - result.wasmMilliseconds) < 0.05
  ) {
    comparisonText = "今回はほぼ同じ速さでした。";
    comparisonDetail = "実行環境や計算内容によって結果は変わります。";
    comparisonMark = "≈";
  } else if (result && result.wasmMilliseconds < result.jsMilliseconds) {
    comparisonText = `この計算では Rust WebAssembly が約 ${ratio.toFixed(2)} 倍速い結果でした。`;
    comparisonDetail = "条件を変えて、もう一度試してみてください。";
  } else if (result) {
    comparisonText = `今回は JavaScript が約 ${ratio.toFixed(2)} 倍速い結果でした。`;
    comparisonDetail =
      "WebAssembly の得意さは処理内容やブラウザによって異なります。";
  }

  return (
    <>
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="WASM / JS ホーム">
          <span className="wordmark-mark" aria-hidden="true" />
          <span>計算の実験室</span>
        </Link>
        <span className="topbar-note">
          BROWSER COMPUTE STUDY <span>—</span> 01
        </span>
      </header>

      <main>
        <section className="intro" aria-labelledby="page-title">
          <p className="kicker">
            <span className="kicker-dot" /> ふたつの実行環境、ひとつの計算
          </p>
          <h1 id="page-title">
            速さの違いを、
            <br className="mobile-break" />
            目で見てみよう。
          </h1>
          <p className="intro-copy">
            マンデルブロ集合を同じ条件で描画します。JavaScript と Rust
            WebAssembly、それぞれの計算時間と生まれる図形を比べてみてください。
          </p>
        </section>

        <section className="workbench" aria-labelledby="experiment-title">
          <div className="workbench-head">
            <div>
              <p className="section-index">計算実験</p>
              <h2 id="experiment-title">マンデルブロ集合</h2>
            </div>
            <div className="workload-control">
              <label htmlFor="resolution">描画サイズ</label>
              <select
                id="resolution"
                name="resolution"
                value={resolution}
                disabled={isRunning}
                onChange={(event) =>
                  setResolution(event.target.value as keyof typeof RESOLUTIONS)
                }
              >
                <option value="320x180">小さめ · 320 × 180</option>
                <option value="640x360">標準 · 640 × 360</option>
                <option value="960x540">大きめ · 960 × 540</option>
              </select>
            </div>
          </div>

          <div className="visualization">
            <canvas
              ref={canvasRef}
              className={hasRendered ? "is-visible" : ""}
              aria-label="マンデルブロ集合の描画結果"
            >
              Canvas に対応したブラウザでご覧ください。
            </canvas>
            {!hasRendered && (
              <div className="canvas-overlay">
                <span className="overlay-mark" aria-hidden="true">
                  ∿
                </span>
                <p>{isRunning ? "計算しています" : "まだ計算していません"}</p>
                <span>実行すると、ここに図形が現れます</span>
              </div>
            )}
            <div className="canvas-caption">
              <span>
                <span className="caption-dot" /> 計算結果のプレビュー
              </span>
              <span>
                {(width * height).toLocaleString("ja-JP")} ピクセル · 最大{" "}
                {ITERATIONS} 回反復
              </span>
            </div>
          </div>

          <div className="run-row">
            <div className="run-explanation">
              <span
                className={`run-indicator${isRunning ? " is-running" : ""}`}
                aria-hidden="true"
              />
              <p role="status" aria-live="polite">
                {status}
              </p>
            </div>
            <button
              className="run-button"
              type="button"
              disabled={isRunning}
              onClick={runBenchmark}
            >
              <span className="button-icon" aria-hidden="true">
                ▶
              </span>
              <span>
                {isRunning ?
                  "計算中"
                : result ?
                  "もう一度比較"
                : "比較を実行"}
              </span>
            </button>
          </div>

          <div className="results" aria-label="計測結果">
            <article className="result-row">
              <div className="engine-name">
                <span className="engine-symbol js-symbol" aria-hidden="true">
                  JS
                </span>
                <div>
                  <h3>JavaScript</h3>
                  <p>ブラウザの標準エンジン</p>
                </div>
              </div>
              <div className="bar-track" aria-hidden="true">
                <div
                  className="bar js-bar"
                  style={{
                    width:
                      result ?
                        `${Math.max(3, (result.jsMilliseconds / longest) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
              <div className="result-time">
                <span>{result ? formatTime(result.jsMilliseconds) : "—"}</span>
                <small>ミリ秒</small>
              </div>
            </article>
            <article className="result-row">
              <div className="engine-name">
                <span className="engine-symbol wasm-symbol" aria-hidden="true">
                  Rs
                </span>
                <div>
                  <h3>Rust + WebAssembly</h3>
                  <p>コンパイル済みのバイナリ</p>
                </div>
              </div>
              <div className="bar-track" aria-hidden="true">
                <div
                  className="bar wasm-bar"
                  style={{
                    width:
                      result ?
                        `${Math.max(3, (result.wasmMilliseconds / longest) * 100)}%`
                      : "0%",
                  }}
                />
              </div>
              <div className="result-time">
                <span>
                  {result ? formatTime(result.wasmMilliseconds) : "—"}
                </span>
                <small>ミリ秒</small>
              </div>
            </article>
          </div>

          <div
            className={`comparison${result && !matching ? " is-warning" : ""}`}
            aria-live="polite"
          >
            <span className="comparison-mark" aria-hidden="true">
              {comparisonMark}
            </span>
            <p>
              {comparisonText}
              <span>{comparisonDetail}</span>
            </p>
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
        </section>

        <section className="method" aria-label="実験の条件">
          <div className="method-copy">
            <span className="method-symbol" aria-hidden="true">
              f(z) = z² + c
            </span>
            <p>公平に比べるために</p>
          </div>
          <p className="method-description">
            同じ計算式・同じピクセル数で、両方をウォームアップしてから交互に3回ずつ計測。
            表示する時間は3回の中央値です。結果が一致しない場合は、比較結果に注意を表示します。
          </p>
        </section>
      </main>

      <footer className="footer">
        <span>ブラウザ上で実行 · サーバーへのデータ送信なし</span>
        <span>測定値は端末・ブラウザ・負荷によって変わります</span>
      </footer>
    </>
  );
}
