import type React from "react";
import { useRef, useState, useEffect } from "react";

// Parameter interface
type FilmLookParams = {
	toneA: number;
	glowThreshold: number;
	glowStrength: number;
	glowBlur: number;
	grainStrength: number;
	softFocusStrength: number;
	softFocusRadius: number;
};

// Default values
const defaultParams: FilmLookParams = {
	toneA: 5.0,
	glowThreshold: 0.7,
	glowStrength: 0.4,
	glowBlur: 40,
	grainStrength: 0.02,
	softFocusStrength: 0.3,
	softFocusRadius: 10,
};

// Helper: clamp 0..1
function clamp(v: number): number {
	return Math.min(Math.max(v, 0), 1);
}

// Blur using offscreen canvas
async function blur(
	data: Uint8ClampedArray,
	w: number,
	h: number,
	r: number,
): Promise<Uint8ClampedArray> {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2D context not available");
	ctx.putImageData(new ImageData(data, w, h), 0, 0);
	ctx.filter = `blur(${r}px)`;
	ctx.drawImage(canvas, 0, 0);
	const result = ctx.getImageData(0, 0, w, h).data;
	return result;
}

// Blur with separate source to include edges
async function blurSeparate(
	data: Uint8ClampedArray,
	w: number,
	h: number,
	r: number,
): Promise<Uint8ClampedArray> {
	const src = document.createElement("canvas");
	src.width = w;
	src.height = h;
	const sctx = src.getContext("2d");
	if (!sctx) throw new Error("2D context not available");
	sctx.putImageData(new ImageData(data, w, h), 0, 0);

	const dst = document.createElement("canvas");
	dst.width = w;
	dst.height = h;
	const dctx = dst.getContext("2d");
	if (!dctx) throw new Error("2D context not available");
	dctx.filter = `blur(${r}px)`;
	dctx.drawImage(src, 0, 0);
	return dctx.getImageData(0, 0, w, h).data;
}

// Core image processing
async function applyFilmLook(
	imgData: ImageData,
	w: number,
	h: number,
	params: FilmLookParams,
): Promise<ImageData> {
	const len = w * h;
	const px = imgData.data;
	const R = new Float32Array(len);
	const G = new Float32Array(len);
	const B = new Float32Array(len);
	const lum = new Float32Array(len);

	// Tone map & grade
	for (let i = 0; i < len; i++) {
		const r0 = px[i * 4] / 255;
		const g0 = px[i * 4 + 1] / 255;
		const b0 = px[i * 4 + 2] / 255;
		const tc_r = 1 / (1 + Math.exp(-params.toneA * (r0 - 0.5)));
		const tc_g = 1 / (1 + Math.exp(-params.toneA * (g0 - 0.5)));
		const tc_b = 1 / (1 + Math.exp(-params.toneA * (b0 - 0.5)));
		const l = 0.2126 * tc_r + 0.7152 * tc_g + 0.0722 * tc_b;
		lum[i] = l;
		const shadowM = clamp((0.5 - l) * 2);
		const highlightM = clamp((l - 0.5) * 2);
		R[i] = clamp(tc_r + shadowM * -0.05 + highlightM * 0.08);
		G[i] = clamp(tc_g + shadowM * 0.0 + highlightM * 0.04);
		B[i] = clamp(tc_b + shadowM * 0.05 + highlightM * -0.02);
	}

	// Glow mask and blur
	const mask = new Uint8ClampedArray(len * 4);
	for (let i = 0; i < len; i++) {
		const m = lum[i] > params.glowThreshold ? 255 : 0;
		mask.set([m, m, m, 255], i * 4);
	}
	const glow = await blur(mask, w, h, params.glowBlur);

	// Combine + grain
	const out = new Uint8ClampedArray(len * 4);
	for (let i = 0; i < len; i++) {
		let rr = R[i] + (glow[i * 4] / 255) * params.glowStrength;
		let gg = G[i] + (glow[i * 4 + 1] / 255) * params.glowStrength;
		let bb = B[i] + (glow[i * 4 + 2] / 255) * params.glowStrength;
		const noise = (Math.random() * 2 - 1) * params.grainStrength;
		const wt = 0.7 + 0.3 * lum[i];
		rr = clamp(rr + noise * wt);
		gg = clamp(gg + noise * wt);
		bb = clamp(bb + noise * wt);
		out.set([rr * 255, gg * 255, bb * 255, 255], i * 4);
	}

	// Soft focus with edge-aware blur
	const soft = await blurSeparate(out, w, h, params.softFocusRadius);
	const final = new Uint8ClampedArray(len * 4);
	for (let i = 0; i < len; i++) {
		const ix = i * 4;
		const r0 = out[ix] / 255;
		const g0 = out[ix + 1] / 255;
		const b0 = out[ix + 2] / 255;
		const r1 = soft[ix] / 255;
		const g1 = soft[ix + 1] / 255;
		const b1 = soft[ix + 2] / 255;
		final.set(
			[
				(r0 * (1 - params.softFocusStrength) + r1 * params.softFocusStrength) *
					255,
				(g0 * (1 - params.softFocusStrength) + g1 * params.softFocusStrength) *
					255,
				(b0 * (1 - params.softFocusStrength) + b1 * params.softFocusStrength) *
					255,
				255,
			],
			ix,
		);
	}

	return new ImageData(final, w, h);
}

// Main React component
const App: React.FC = () => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [downloadUrl, setDownloadUrl] = useState<string>("");
	const [params, setParams] = useState<FilmLookParams>(defaultParams);
	const [origData, setOrigData] = useState<ImageData | null>(null);
	const [procData, setProcData] = useState<ImageData | null>(null);
	const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
	const debounce = useRef<number | undefined>(undefined);

	// Debounced processing
	useEffect(() => {
		if (!origData || !dim) return;
		if (debounce.current !== undefined) clearTimeout(debounce.current);
		debounce.current = window.setTimeout(async () => {
			const processed = await applyFilmLook(origData, dim.w, dim.h, params);
			setProcData(processed);
			const canvas = canvasRef.current;
			if (!canvas) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.putImageData(processed, 0, 0);
			canvas.toBlob(
				(blob) => {
					if (blob) setDownloadUrl(URL.createObjectURL(blob));
				},
				"image/jpeg",
				0.9,
			);
		}, 100);
		return () => {
			if (debounce.current !== undefined) clearTimeout(debounce.current);
		};
	}, [params, origData, dim]);

	// Preview toggle on press
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !origData || !procData) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		const showOrig = () => ctx.putImageData(origData, 0, 0);
		const showProc = () => ctx.putImageData(procData, 0, 0);
		canvas.addEventListener("mousedown", showOrig);
		canvas.addEventListener("mouseup", showProc);
		canvas.addEventListener("touchstart", showOrig);
		canvas.addEventListener("touchend", showProc);
		return () => {
			canvas.removeEventListener("mousedown", showOrig);
			canvas.removeEventListener("mouseup", showProc);
			canvas.removeEventListener("touchstart", showOrig);
			canvas.removeEventListener("touchend", showProc);
		};
	}, [origData, procData]);

	// File upload handler
	const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const img = await createImageBitmap(file);
		const maxSize = 1600;
		const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
		const w = Math.round(img.width * scale);
		const h = Math.round(img.height * scale);
		const canvas = canvasRef.current;
		if (!canvas) return;
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, w, h);
		ctx.drawImage(img, 0, 0, w, h);
		const off = document.createElement("canvas");
		off.width = w;
		off.height = h;
		const offCtx = off.getContext("2d");
		if (!offCtx) return;
		offCtx.drawImage(img, 0, 0, w, h);
		const data = offCtx.getImageData(0, 0, w, h);
		setOrigData(data);
		setDim({ w, h });
		canvas.toBlob(
			(blob) => blob && setDownloadUrl(URL.createObjectURL(blob)),
			"image/jpeg",
			0.9,
		);
	};

	// FilmLookParamsのkeyを型安全に取得
	type ParamKey = keyof FilmLookParams;
	const paramList: {
		label: string;
		key: ParamKey;
		min: number;
		max: number;
		step: number;
	}[] = [
		{ label: "Tone A", key: "toneA", min: 1, max: 10, step: 0.1 },
		{ label: "Glow Thr", key: "glowThreshold", min: 0, max: 1, step: 0.01 },
		{ label: "Glow Str", key: "glowStrength", min: 0, max: 1, step: 0.01 },
		{ label: "Glow Blur", key: "glowBlur", min: 0, max: 100, step: 1 },
		{ label: "Grain Str", key: "grainStrength", min: 0, max: 0.1, step: 0.001 },
		{ label: "Soft Str", key: "softFocusStrength", min: 0, max: 1, step: 0.01 },
		{ label: "Soft Blur", key: "softFocusRadius", min: 0, max: 50, step: 1 },
	];

	return (
		<div
			style={{
				maxWidth: 900,
				margin: "0 auto",
				padding: 12,
				background: "linear-gradient(135deg, #f8fafc 0%, #e3e8ee 100%)",
				fontFamily: "Segoe UI, 'Hiragino Sans', 'Meiryo', sans-serif",
				minHeight: "100vh",
			}}
		>
			<div
				style={{
					display: "flex",
					gap: 32,
					flexWrap: "wrap",
					marginBottom: 32,
					alignItems: "flex-start",
				}}
			>
				<div
					style={{
						flex: "1 1 300px",
						background: "#fff",
						padding: 20,
						borderRadius: 16,
						boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
						border: "1px solid #e5e7eb",
						minWidth: 260,
						transition: "box-shadow 0.2s",
					}}
				>
					<h2
						style={{
							fontSize: 20,
							marginBottom: 18,
							color: "#444",
							letterSpacing: 0.5,
						}}
					>
						Adjustments
					</h2>
					{paramList.map(({ label, key, min, max, step }) => (
						<div key={key} style={{ marginBottom: 20 }}>
							<label
								htmlFor={key}
								style={{
									display: "block",
									marginBottom: 6,
									color: "#222",
									fontWeight: 500,
									fontSize: 15,
									letterSpacing: 0.2,
								}}
							>
								{label}:{" "}
								<span style={{ color: "#0062ff", fontWeight: 600 }}>
									{params[key].toFixed(step < 1 ? 3 : 0)}
								</span>
							</label>
							<input
								id={key}
								type="range"
								min={min}
								max={max}
								step={step}
								value={params[key] as number}
								onChange={(e) =>
									setParams((p) => ({
										...p,
										[key]: Number.parseFloat(e.target.value),
									}))
								}
								style={{
									width: "100%",
									accentColor: "#0062ff",
									height: 8, // 変更: 高さを8に
									borderRadius: 4, // 変更: 角丸を4に
									background: "#e5e7eb",
									cursor: "pointer",
								}}
							/>
						</div>
					))}
				</div>
				<div
					style={{
						flex: "2 1 500px",
						textAlign: "center",
						background: "#fff",
						borderRadius: 16,
						boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
						border: "1px solid #e5e7eb",
						padding: 20,
						transition: "box-shadow 0.2s",
						minWidth: 320,
					}}
				>
					<div
						style={{
							marginBottom: 18,
							display: "flex",
							gap: 12,
							justifyContent: "center",
						}}
					>
						<label
							htmlFor="file-upload"
							style={{
								display: "inline-block",
								padding: "10px 20px",
								background: "linear-gradient(90deg, #0062ff 60%, #338bff 100%)",
								color: "#fff",
								borderRadius: 6,
								textDecoration: "none",
								cursor: "pointer",
								fontWeight: 500,
								fontSize: 15,
								boxShadow: "0 2px 8px rgba(0,98,255,0.08)",
								transition: "background 0.2s, box-shadow 0.2s",
								border: "none",
								outline: "none",
							}}
							onMouseOver={(e) => {
								e.currentTarget.style.background = "#338bff";
							}}
							onMouseOut={(e) => {
								e.currentTarget.style.background =
									"linear-gradient(90deg, #0062ff 60%, #338bff 100%)";
							}}
							onFocus={(e) => {
								e.currentTarget.style.background = "#338bff";
							}}
							onBlur={(e) => {
								e.currentTarget.style.background =
									"linear-gradient(90deg, #0062ff 60%, #338bff 100%)";
							}}
						>
							ファイルを選択
							<input
								id="file-upload"
								type="file"
								accept="image/*"
								onChange={onFile}
								style={{ display: "none" }}
							/>
						</label>
						{downloadUrl && (
							<a
								href={downloadUrl}
								download="filmlook.jpg"
								style={{
									display: "inline-block",
									padding: "10px 20px",
									background:
										"linear-gradient(90deg, #0062ff 60%, #338bff 100%)",
									color: "#fff",
									borderRadius: 6,
									textDecoration: "none",
									fontWeight: 500,
									fontSize: 15,
									boxShadow: "0 2px 8px rgba(0,98,255,0.08)",
									transition: "background 0.2s, box-shadow 0.2s",
									border: "none",
									outline: "none",
								}}
								onMouseOver={(e) => {
									e.currentTarget.style.background = "#338bff";
								}}
								onFocus={(e) => {
									e.currentTarget.style.background = "#338bff";
								}}
								onMouseOut={(e) => {
									e.currentTarget.style.background =
										"linear-gradient(90deg, #0062ff 60%, #338bff 100%)";
								}}
								onBlur={(e) => {
									e.currentTarget.style.background =
										"linear-gradient(90deg, #0062ff 60%, #338bff 100%)";
								}}
							>
								Download
							</a>
						)}
					</div>
					<div
						style={{
							border: "2px solid #e5e7eb",
							borderRadius: 12,
							overflow: "hidden",
							background: "#000",
							boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
							margin: "0 auto",
							maxWidth: 600,
						}}
					>
						<canvas
							ref={canvasRef}
							style={{
								display: "block",
								width: "100%",
								background: "#111",
								borderRadius: 0,
							}}
						/>
					</div>
				</div>
			</div>
			<p
				style={{
					textAlign: "center",
					fontSize: 13,
					color: "#aaa",
					marginTop: 40,
					letterSpacing: 0.5,
					userSelect: "none",
				}}
			>
				© Daiki Ikeda 2025
			</p>
		</div>
	);
};

export default App;
