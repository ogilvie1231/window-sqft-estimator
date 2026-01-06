import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

type BoxType = "reference" | "window";

type Box = {
  id: string;
  type: BoxType;
  label: string;
  x: number; // in image pixel coords
  y: number;
  w: number;
  h: number;
};

type PricingConfig = {
  // You can tune these freely for your partnership/MVP
  materialCostPerSqft: number; // your cost
  laborCostPerSqft: number; // install labor allocation
  miscPerJob: number; // blades, solution, travel buffer, etc.
  minCharge: number; // minimum job charge
  marginFloor: number; // e.g. 0.45 = 45%
  marginTarget: number; // e.g. 0.55 = 55%
  marginStretch: number; // e.g. 0.65 = 65%
};

const DEFAULT_PRICING: PricingConfig = {
  materialCostPerSqft: 2.25,
  laborCostPerSqft: 3.25,
  miscPerJob: 35,
  minCharge: 399,
  marginFloor: 0.45,
  marginTarget: 0.55,
  marginStretch: 0.65,
};

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [imageUrl, setImageUrl] = useState<string>("");
  const [imageNatural, setImageNatural] = useState<{ w: number; h: number } | null>(null);

  const [boxes, setBoxes] = useState<Box[]>([]);
  const [activeDrawType, setActiveDrawType] = useState<BoxType>("reference");

  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draftBox, setDraftBox] = useState<Box | null>(null);

  const [refPreset, setRefPreset] = useState<"paper" | "door" | "custom">("paper");
  const [refRealInches, setRefRealInches] = useState<number>(11); // paper height default 11"
  const [pricing, setPricing] = useState<PricingConfig>(DEFAULT_PRICING);

  // derived: reference pixels per inch (ppi) using reference box height
  const referenceBox = useMemo(() => boxes.find((b) => b.type === "reference") ?? null, [boxes]);

  const pixelsPerInch = useMemo(() => {
    if (!referenceBox) return null;
    const real = refRealInches > 0 ? refRealInches : null;
    if (!real) return null;
    // Use height as the scaling axis (more stable in portrait shots)
    return referenceBox.h / real;
  }, [referenceBox, refRealInches]);

  const windowBoxes = useMemo(() => boxes.filter((b) => b.type === "window"), [boxes]);

  const windowSqft = useMemo(() => {
    if (!pixelsPerInch) return null;
    const ppi = pixelsPerInch;
    let total = 0;
    for (const b of windowBoxes) {
      const wIn = b.w / ppi;
      const hIn = b.h / ppi;
      const sqft = (wIn * hIn) / 144;
      total += sqft;
    }
    return total;
  }, [pixelsPerInch, windowBoxes]);

  const costAndPrice = useMemo(() => {
    if (!windowSqft) return null;

    const sqft = windowSqft;

    const rawCost =
      sqft * (pricing.materialCostPerSqft + pricing.laborCostPerSqft) + pricing.miscPerJob;

    // Minimum charge applied at sell-price level typically, but we’ll also protect cost floor
    const protectedCost = Math.max(rawCost, pricing.minCharge * (1 - pricing.marginFloor));

    const floor = protectedCost / (1 - pricing.marginFloor);
    const target = protectedCost / (1 - pricing.marginTarget);
    const stretch = protectedCost / (1 - pricing.marginStretch);

    const finalFloor = Math.max(floor, pricing.minCharge);
    const finalTarget = Math.max(target, pricing.minCharge);
    const finalStretch = Math.max(stretch, pricing.minCharge);

    return {
      sqft,
      rawCost,
      protectedCost,
      sellFloor: finalFloor,
      sellTarget: finalTarget,
      sellStretch: finalStretch,
    };
  }, [windowSqft, pricing]);

  function resetAll() {
    setBoxes([]);
    setDraftBox(null);
    setDragStart(null);
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setImageUrl(url);
    resetAll();
  }

  function syncRefPreset(p: "paper" | "door" | "custom") {
    setRefPreset(p);
    if (p === "paper") setRefRealInches(11); // use height
    if (p === "door") setRefRealInches(80); // common door height
    // custom leaves current value
  }

  function getCanvasAndImageScale() {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageNatural) return null;

    // Canvas is sized via CSS; we draw in canvas pixel space matching its displayed size.
    const rect = canvas.getBoundingClientRect();
    const displayW = rect.width;
    const displayH = rect.height;

    // Image is fit "contain" into the canvas area
    const imgAspect = imageNatural.w / imageNatural.h;
    const canvasAspect = displayW / displayH;

    let drawW = displayW;
    let drawH = displayH;
    let offsetX = 0;
    let offsetY = 0;

    if (imgAspect > canvasAspect) {
      // image is wider than canvas
      drawW = displayW;
      drawH = displayW / imgAspect;
      offsetY = (displayH - drawH) / 2;
    } else {
      drawH = displayH;
      drawW = displayH * imgAspect;
      offsetX = (displayW - drawW) / 2;
    }

    // scale from image natural coords -> displayed draw coords
    const scale = drawW / imageNatural.w;

    return { canvas, rect, drawW, drawH, offsetX, offsetY, scale };
  }

  function canvasPointToImagePoint(clientX: number, clientY: number) {
    const info = getCanvasAndImageScale();
    if (!info) return null;

    const { rect, offsetX, offsetY, scale, drawW, drawH } = info;
    const xCanvas = clientX - rect.left;
    const yCanvas = clientY - rect.top;

    const xInDraw = xCanvas - offsetX;
    const yInDraw = yCanvas - offsetY;

    if (xInDraw < 0 || yInDraw < 0 || xInDraw > drawW || yInDraw > drawH) return null;

    // convert to image natural px
    const xImg = xInDraw / scale;
    const yImg = yInDraw / scale;

    return { x: xImg, y: yImg };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!imageUrl) return;
    const pt = canvasPointToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    setDragStart(pt);

    // start a draft box at 1px to show feedback
    const isRef = activeDrawType === "reference";
    const label =
      activeDrawType === "reference"
        ? refPreset === "paper"
          ? "Paper (11in tall)"
          : refPreset === "door"
          ? "Door (80in tall)"
          : "Reference"
        : `Window ${windowBoxes.length + 1}`;

    setDraftBox({
      id: "draft",
      type: activeDrawType,
      label,
      x: pt.x,
      y: pt.y,
      w: 1,
      h: 1,
    });
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragStart || !draftBox) return;
    const pt = canvasPointToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    const x1 = dragStart.x;
    const y1 = dragStart.y;
    const x2 = pt.x;
    const y2 = pt.y;

    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);

    setDraftBox({ ...draftBox, x, y, w, h });
  }

  function handlePointerUp() {
    if (!draftBox) {
      setDragStart(null);
      return;
    }

    // ignore tiny boxes
    if (draftBox.w < 10 || draftBox.h < 10) {
      setDraftBox(null);
      setDragStart(null);
      return;
    }

    // If drawing reference, replace any existing reference box
    if (draftBox.type === "reference") {
      setBoxes((prev) => [
        ...prev.filter((b) => b.type !== "reference"),
        { ...draftBox, id: uid() },
      ]);
    } else {
      setBoxes((prev) => [...prev, { ...draftBox, id: uid() }]);
    }

    setDraftBox(null);
    setDragStart(null);
  }

  function deleteBox(id: string) {
    setBoxes((prev) => prev.filter((b) => b.id !== id));
  }

  // draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageNatural) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const displayW = Math.floor(rect.width);
    const displayH = Math.floor(rect.height);

    // set actual canvas backing store to match display size for crispness
    if (canvas.width !== displayW) canvas.width = displayW;
    if (canvas.height !== displayH) canvas.height = displayH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const info = getCanvasAndImageScale();
    if (!info) return;
    const { drawW, drawH, offsetX, offsetY, scale } = info;

    // draw image
    ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

    // helper to draw a box from image coords
    const drawBox = (b: Box, stroke: string) => {
  const x = offsetX + b.x * scale;
  const y = offsetY + b.y * scale;
  const w = b.w * scale;
  const h = b.h * scale;

  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;
  ctx.strokeRect(x, y, w, h);
};

    // existing boxes
    for (const b of boxes) {
      if (b.type === "reference") drawBox(b, "rgba(0,180,220,0.9)");
  else drawBox(b, "rgba(255,200,0,0.9)");
    }

    // draft box
   if (draftBox) {
  const color = draftBox.type === "reference"
    ? "rgba(0,180,220,0.9)"
    : "rgba(255,200,0,0.9)";
  drawBox(draftBox, color);
}
  }, [boxes, draftBox, imageUrl, imageNatural]);

  return (
    <div className="wrap">
      <header className="header">
        <div>
          <h1>Window SqFt Estimator (Prototype)</h1>
          <p className="sub">
            1) Upload photo → 2) Draw <b>Reference</b> → 3) Draw <b>Windows</b> → 4) Get SqFt + Pricing
          </p>
        </div>
      </header>

      <div className="grid">
        <section className="card">
          <h2>Photo</h2>
          <div className="row">
            <input type="file" accept="image/*" capture="environment" onChange={onFileChange} />
            <button className="btn" onClick={resetAll} disabled={!imageUrl}>
              Clear boxes
            </button>
          </div>

          {!imageUrl ? (
            <div className="empty">
              Upload a house/window photo. On iPhone, this will let you take a photo from the camera.
            </div>
          ) : (
            <>
              {/* Hidden image element used for drawing */}
              <img
                ref={imgRef}
                src={imageUrl}
                alt="uploaded"
                style={{ display: "none" }}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setImageNatural({ w: el.naturalWidth, h: el.naturalHeight });
                }}
              />

              <div className="canvasWrap">
                <canvas
                  ref={canvasRef}
                  className="canvas"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerLeave={() => {
                    // end drawing if pointer leaves
                    setDragStart(null);
                    setDraftBox(null);
                  }}
                />
              </div>

              <div className="row">
                <div className="seg">
                  <button
                    className={activeDrawType === "reference" ? "segBtn active" : "segBtn"}
                    onClick={() => setActiveDrawType("reference")}
                  >
                    Draw Reference
                  </button>
                  <button
                    className={activeDrawType === "window" ? "segBtn active" : "segBtn"}
                    onClick={() => setActiveDrawType("window")}
                  >
                    Draw Windows
                  </button>
                </div>

                <div className="hint">
                  Tip: reference first (paper/door), then windows. Drag a rectangle around each.
                </div>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <h2>Reference & Scale</h2>

          <div className="row">
            <label className="label">Reference preset</label>
            <select
              value={refPreset}
              onChange={(e) => syncRefPreset(e.target.value as any)}
              className="input"
            >
              <option value="paper">Letter paper (11&quot; tall)</option>
              <option value="door">Standard door (80&quot; tall)</option>
              <option value="custom">Custom (inches)</option>
            </select>
          </div>

          <div className="row">
            <label className="label">Reference height (inches)</label>
            <input
              className="input"
              type="number"
              value={refRealInches}
              min={1}
              step={0.25}
              onChange={(e) => setRefRealInches(Number(e.target.value))}
              disabled={refPreset !== "custom" && refPreset !== "paper" && refPreset !== "door" ? false : false}
            />
          </div>

          <div className="status">
            <div>
              <b>Reference box:</b>{" "}
              {referenceBox ? (
                <>
                  set ({Math.round(referenceBox.w)}×{Math.round(referenceBox.h)} px)
                </>
              ) : (
                <span className="warn">not set (draw it on the photo)</span>
              )}
            </div>
            <div>
              <b>Pixels per inch:</b>{" "}
              {pixelsPerInch ? round2(pixelsPerInch) : <span className="warn">—</span>}
            </div>
          </div>

          <hr />

          <h2>Windows</h2>
          <div className="status">
            <div>
              <b>Windows marked:</b> {windowBoxes.length}
            </div>
            <div>
              <b>Total SqFt:</b>{" "}
              {windowSqft ? round2(windowSqft) : <span className="warn">—</span>}
            </div>
          </div>

          {windowBoxes.length > 0 && (
            <div className="list">
              {windowBoxes.map((b) => (
                <div key={b.id} className="listRow">
                  <div>
                    <b>{b.label}</b>
                    <div className="muted">
                      {Math.round(b.w)}×{Math.round(b.h)} px
                    </div>
                  </div>
                  <button className="link" onClick={() => deleteBox(b.id)}>
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {referenceBox && (
            <div className="list">
              <div className="listRow">
                <div>
                  <b>Reference</b>
                  <div className="muted">{referenceBox.label}</div>
                </div>
                <button className="link" onClick={() => deleteBox(referenceBox.id)}>
                  remove
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="card">
  <h2>Retail & Commission</h2>

  {(!windowSqft || !pixelsPerInch) ? (
    <div className="empty">
      Draw a <b>reference</b> + at least one <b>window</b> to generate pricing.
    </div>
  ) : (
    (() => {
      const sqft = windowSqft;

      const SOLAR_PER_SQFT = 12;     // fixed internal baseline
      const RETAIL_LOW_PER_SQFT = 14;
      const RETAIL_HIGH_PER_SQFT = 16;

      const solarTotal = sqft * SOLAR_PER_SQFT;

      const retailLowTotal = sqft * RETAIL_LOW_PER_SQFT;
      const retailHighTotal = sqft * RETAIL_HIGH_PER_SQFT;

      const commissionLow = retailLowTotal - solarTotal;
      const commissionHigh = retailHighTotal - solarTotal;

      const r2 = (n: number) => Math.round(n * 100) / 100;
      const dollars = (n: number) => `$${Math.round(n).toLocaleString()}`;

      return (
        <div className="result">
          <div className="kpi">
            <div className="kpiLabel">Estimated window area</div>
            <div className="kpiValue">{r2(sqft)} sq ft</div>
          </div>

          <div className="kpi">
            <div className="kpiLabel">Suggested retail range</div>
            <div className="kpiValue">
              {dollars(retailLowTotal)} – {dollars(retailHighTotal)}
            </div>
            <div className="muted">
              ${RETAIL_LOW_PER_SQFT}–${RETAIL_HIGH_PER_SQFT}/sqft
            </div>
          </div>

          <div className="kpi">
            <div className="kpiLabel">Estimated commission</div>
            <div className="kpiValue">
              {dollars(commissionLow)} – {dollars(commissionHigh)}
            </div>
            <div className="muted">
              Commission = Retail − Solar (${SOLAR_PER_SQFT}/sqft)
            </div>
          </div>

          <button
            className="btnPrimary"
            onClick={() => {
              const lines = [
                `Window SqFt Estimate`,
                `SqFt: ${r2(sqft)}`,
                `Suggested retail: ${dollars(retailLowTotal)} – ${dollars(retailHighTotal)} (${RETAIL_LOW_PER_SQFT}–${RETAIL_HIGH_PER_SQFT}/sqft)`,
                `Estimated commission: ${dollars(commissionLow)} – ${dollars(commissionHigh)} (Retail − Solar @ $${SOLAR_PER_SQFT}/sqft)`,
              ];
              navigator.clipboard.writeText(lines.join("\n"));
              alert("Copied estimate to clipboard.");
            }}
          >
            Copy estimate
          </button>
        </div>
      );
    })()
  )}
</section>
      </div>

      <footer className="footer">
        Prototype notes: This is a “rough estimate” tool. Accuracy depends on a clean reference box and reasonably flat photo
        perspective. Next iteration can add multi-photos per room/elevation + averaging.
      </footer>
    </div>
  );
}