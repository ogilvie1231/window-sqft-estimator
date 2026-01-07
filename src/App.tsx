import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
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

  // View transform (pinch zoom + pan) in BASE canvas space
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 });

  // Pinch tracking
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<null | {
    dist: number;
    mid: { x: number; y: number };
    scale: number;
    tx: number;
    ty: number;
  }>(null);

  function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function mid(a: { x: number; y: number }, b: { x: number; y: number }) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function clampScale(s: number) {
    return Math.max(1, Math.min(6, s)); // min 1x, max 6x
  }

  // derived: reference pixels per inch (ppi) using reference box height
  const referenceBox = useMemo(() => boxes.find((b) => b.type === "reference") ?? null, [boxes]);

  const pixelsPerInch = useMemo(() => {
    if (!referenceBox) return null;
    const real = refRealInches > 0 ? refRealInches : null;
    if (!real) return null;
    return referenceBox.h / real; // use height axis
  }, [referenceBox, refRealInches]);

  const windowBoxes = useMemo(() => boxes.filter((b) => b.type === "window"), [boxes]);

  const windowSqft = useMemo(() => {
    if (!pixelsPerInch) return null;
    const ppi = pixelsPerInch;
    let total = 0;
    for (const b of windowBoxes) {
      const wIn = b.w / ppi;
      const hIn = b.h / ppi;
      total += (wIn * hIn) / 144;
    }
    return total;
  }, [pixelsPerInch, windowBoxes]);

  function resetAll() {
    setBoxes([]);
    setDraftBox(null);
    setDragStart(null);
  }

  function resetView() {
    setView({ scale: 1, tx: 0, ty: 0 });
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    setImageUrl(url);
    resetAll();
    resetView();
  }

  function syncRefPreset(p: "paper" | "door" | "custom") {
    setRefPreset(p);
    if (p === "paper") setRefRealInches(11);
    if (p === "door") setRefRealInches(80);
  }

  /**
   * Base "contain" geometry for mapping image px -> base canvas px (before zoom).
   * Returns baseW/baseH + offsets in canvas CSS pixels, and baseScale (image->base).
   */
  const getCanvasAndImageScale = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageNatural) return null;

    const rect = canvas.getBoundingClientRect();
    const displayW = rect.width;
    const displayH = rect.height;

    const imgAspect = imageNatural.w / imageNatural.h;
    const canvasAspect = displayW / displayH;

    let baseW = displayW;
    let baseH = displayH;
    let baseOffsetX = 0;
    let baseOffsetY = 0;

    if (imgAspect > canvasAspect) {
      baseW = displayW;
      baseH = displayW / imgAspect;
      baseOffsetY = (displayH - baseH) / 2;
    } else {
      baseH = displayH;
      baseW = displayH * imgAspect;
      baseOffsetX = (displayW - baseW) / 2;
    }

    const baseScale = baseW / imageNatural.w;

    return { canvas, rect, baseW, baseH, baseOffsetX, baseOffsetY, baseScale };
  }, [imageNatural]);

  function canvasPointToImagePoint(clientX: number, clientY: number) {
    const info = getCanvasAndImageScale();
    if (!info || !imageNatural) return null;

    const { rect, baseOffsetX, baseOffsetY, baseScale } = info;

    // Pointer in canvas CSS pixels
    const xCanvas = clientX - rect.left;
    const yCanvas = clientY - rect.top;

    // remove base contain offset
    const xInBase = xCanvas - baseOffsetX;
    const yInBase = yCanvas - baseOffsetY;

    // undo zoom/pan (view transform is in base space)
    const xUnzoom = (xInBase - view.tx) / view.scale;
    const yUnzoom = (yInBase - view.ty) / view.scale;

    // base px -> image px
    const xImg = xUnzoom / baseScale;
    const yImg = yUnzoom / baseScale;

    if (xImg < 0 || yImg < 0) return null;
    if (xImg > imageNatural.w || yImg > imageNatural.h) return null;

    return { x: xImg, y: yImg };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!imageUrl) return;
    const pt = canvasPointToImagePoint(e.clientX, e.clientY);
    if (!pt) return;

    setDragStart(pt);

    const label =
      activeDrawType === "reference"
        ? refPreset === "paper"
          ? "Paper"
          : refPreset === "door"
          ? "Door"
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

    if (draftBox.w < 10 || draftBox.h < 10) {
      setDraftBox(null);
      setDragStart(null);
      return;
    }

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

    if (canvas.width !== displayW) canvas.width = displayW;
    if (canvas.height !== displayH) canvas.height = displayH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const info = getCanvasAndImageScale();
    if (!info) return;

    const { baseW, baseH, baseOffsetX, baseOffsetY, baseScale } = info;

    // draw image with zoom/pan in base space
    ctx.save();
    ctx.translate(baseOffsetX + view.tx, baseOffsetY + view.ty);
    ctx.scale(view.scale, view.scale);
    ctx.drawImage(img, 0, 0, baseW, baseH);
    ctx.restore();

    const drawBox = (b: Box, stroke: string) => {
      const xBase = b.x * baseScale;
      const yBase = b.y * baseScale;
      const wBase = b.w * baseScale;
      const hBase = b.h * baseScale;

      const x = baseOffsetX + view.tx + xBase * view.scale;
      const y = baseOffsetY + view.ty + yBase * view.scale;
      const w = wBase * view.scale;
      const h = hBase * view.scale;

      ctx.lineWidth = window.innerWidth < 980 ? 3 : 2;
      ctx.strokeStyle = stroke;
      ctx.strokeRect(x, y, w, h);
    };

    for (const b of boxes) {
      if (b.type === "reference") drawBox(b, "rgba(0,180,220,0.9)");
      else drawBox(b, "rgba(255,200,0,0.9)");
    }

    if (draftBox) {
      const color =
        draftBox.type === "reference" ? "rgba(0,180,220,0.9)" : "rgba(255,200,0,0.9)";
      drawBox(draftBox, color);
    }
  }, [boxes, draftBox, imageUrl, imageNatural, view, getCanvasAndImageScale]);

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
            <input type="file" accept="image/*" onChange={onFileChange} />
            <button className="btn" onClick={resetAll} disabled={!imageUrl}>
              Clear boxes
            </button>
            <button className="btn" onClick={resetView} disabled={!imageUrl}>
              Reset view
            </button>
          </div>

          {!imageUrl ? (
            <div className="empty">
              Upload a house/window photo. On iPhone, this will let you take a photo or choose from Photos.
            </div>
          ) : (
            <>
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
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
                    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

                    // 2 pointers => pinch/2-finger pan
                    if (pointers.current.size === 2) {
                      const pts = Array.from(pointers.current.values());
                      const d = dist(pts[0], pts[1]);
                      const m = mid(pts[0], pts[1]);
                      pinchStart.current = {
                        dist: d,
                        mid: m,
                        scale: view.scale,
                        tx: view.tx,
                        ty: view.ty,
                      };
                      setDragStart(null);
                      setDraftBox(null);
                      return;
                    }

                    // 1 pointer => draw
                    handlePointerDown(e);
                  }}
                  onPointerMove={(e) => {
                    if (!pointers.current.has(e.pointerId)) return;
                    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

                    // pinch
                    if (pointers.current.size === 2 && pinchStart.current) {
                      const pts = Array.from(pointers.current.values());
                      const dNow = dist(pts[0], pts[1]);
                      const mNow = mid(pts[0], pts[1]);

                      const start = pinchStart.current;
                      const nextScale = clampScale(start.scale * (dNow / start.dist));

                      // midpoint pan in screen space
                      const dxMid = mNow.x - start.mid.x;
                      const dyMid = mNow.y - start.mid.y;

                      setView({
                        scale: nextScale,
                        tx: start.tx + dxMid,
                        ty: start.ty + dyMid,
                      });
                      return;
                    }

                    // draw
                    handlePointerMove(e);
                  }}
                  onPointerUp={(e) => {
                    pointers.current.delete(e.pointerId);

                    if (pointers.current.size < 2) pinchStart.current = null;

                    // Only finalize draw if this was a 1-finger gesture and no pointers remain
                    if (pointers.current.size === 0) {
                      handlePointerUp();
                      pointers.current.clear();
                      pinchStart.current = null;
                    }
                  }}
                  onPointerCancel={(e) => {
                    pointers.current.delete(e.pointerId);
                    pinchStart.current = null;
                    pointers.current.clear();
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

                <div className="hint">Tip: two fingers pinch/drag to zoom + pan.</div>
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
              onChange={(e) => syncRefPreset(e.target.value as "paper" | "door" | "custom")}
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
              disabled={refPreset !== "custom"}
            />
          </div>

          <div className="status">
            <div>
              <b>Reference box:</b>{" "}
              {referenceBox ? (
                <>set ({Math.round(referenceBox.w)}×{Math.round(referenceBox.h)} px)</>
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
              <b>Total SqFt:</b> {windowSqft ? round2(windowSqft) : <span className="warn">—</span>}
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

              const SOLAR_PER_SQFT = 12;
              const RETAIL_LOW_PER_SQFT = 14;
              const RETAIL_HIGH_PER_SQFT = 15;

              const solarTotal = sqft * SOLAR_PER_SQFT;
              const retailLowTotal = sqft * RETAIL_LOW_PER_SQFT;
              const retailHighTotal = sqft * RETAIL_HIGH_PER_SQFT;

              const commissionLow = retailLowTotal - solarTotal;
              const commissionHigh = retailHighTotal - solarTotal;

              const dollars = (n: number) => `$${Math.round(n).toLocaleString()}`;

              return (
                <div className="result">
                  <div className="kpi">
                    <div className="kpiLabel">Estimated window area</div>
                    <div className="kpiValue">{round2(sqft)} sq ft</div>
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
                        `SqFt: ${round2(sqft)}`,
                        `Suggested retail: ${dollars(retailLowTotal)} – ${dollars(
                          retailHighTotal
                        )} (${RETAIL_LOW_PER_SQFT}–${RETAIL_HIGH_PER_SQFT}/sqft)`,
                        `Estimated commission: ${dollars(commissionLow)} – ${dollars(
                          commissionHigh
                        )} (Retail − Solar @ $${SOLAR_PER_SQFT}/sqft)`,
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
        Prototype notes: This is a “rough estimate” tool. Accuracy depends on a clean reference box and reasonably flat
        photo perspective. Next iteration can add multi-photos per room/elevation + averaging.
      </footer>
    </div>
  );
}