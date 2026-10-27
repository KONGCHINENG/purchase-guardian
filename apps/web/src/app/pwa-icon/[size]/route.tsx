import { ImageResponse } from "next/og";

const SIZES = new Set([180, 192, 512]);

/** App icons rendered from the shield mark, so there are no binary assets to keep in sync. */
export async function GET(req: Request, { params }: { params: Promise<{ size: string }> }) {
  const requested = Number((await params).size);
  const size = SIZES.has(requested) ? requested : 192;
  const maskable = new URL(req.url).searchParams.has("maskable");
  const glyph = Math.round(size * (maskable ? 0.5 : 0.62));

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(145deg, #12925f 0%, #0a5c40 100%)",
          borderRadius: maskable ? 0 : size * 0.22,
        }}
      >
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none">
          <path d="M12 2.5 4 5.5v6.2c0 4.6 3.3 8.5 8 9.8 4.7-1.3 8-5.2 8-9.8V5.5l-8-3Z" fill="rgba(255,255,255,0.18)" stroke="#ffffff" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="m8.5 12.2 2.4 2.4 4.7-5" stroke="#ffffff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    { width: size, height: size, headers: { "Cache-Control": "public, max-age=31536000, immutable" } },
  );
}
