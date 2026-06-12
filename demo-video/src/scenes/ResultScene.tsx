// Scene 5: Result — CSV preview + jurisdictions, 12s.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { colors, fonts, sizes, radius } from "../theme";
import { agentOutput } from "../data";

const csvRows = [
  ["2025-01-15", "TRANSFER", "CELO", "−2.5", "$0.75", "wallet", ""],
  ["2025-01-22", "SWAP",      "CELO→cUSD", "−5.0 / +8.2", "$1.50", "ubeswap", "0xab12…"],
  ["2025-02-03", "INCOME",    "cUSD", "+25.0", "$25.00", "mento", "0xcd34…"],
  ["2025-02-10", "YIELD",     "G$",   "+1500", "$0.00", "gooddollar", "0xef56…"],
  ["2025-02-18", "BRIDGE",    "CELO", "−10.0", "$6.00", "portal", "⚠ flagged"],
];

export const ResultScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOpacity = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateRight: "clamp" });
  const tableOpacity = interpolate(frame, [0.8 * fps, 1.6 * fps], [0, 1], { extrapolateRight: "clamp" });
  const tableY = interpolate(frame, [0.8 * fps, 1.6 * fps], [40, 0], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: colors.bg, padding: 80, justifyContent: "center" }}>
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.title, color: colors.accent,
        fontWeight: 800, marginBottom: 8, opacity: headerOpacity,
      }}>
        Output ↓
      </div>
      <div style={{
        fontFamily: fonts.mono, fontSize: sizes.small, color: colors.textDim,
        marginBottom: 32, opacity: headerOpacity,
      }}>
        {agentOutput.csvFile} · {agentOutput.csvRows} rows · {agentOutput.csvSchema}
      </div>

      <div style={{
        background: colors.codeBg, border: `1px solid ${colors.border}`,
        borderRadius: radius.md, padding: 24, fontFamily: fonts.mono,
        fontSize: 18, color: colors.code, opacity: tableOpacity, transform: `translateY(${tableY}px)`,
        overflow: "hidden",
      }}>
        {/* Header row */}
        <div style={{ display: "grid", gridTemplateColumns: "110px 110px 110px 1fr 80px 100px 1fr", gap: 12, color: colors.accent, fontWeight: 700, marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${colors.border}` }}>
          <div>date</div><div>type</div><div>asset</div><div>amount</div><div>usd</div><div>source</div><div>note</div>
        </div>
        {/* Data rows */}
        {csvRows.map((row, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "110px 110px 110px 1fr 80px 100px 1fr", gap: 12,
            padding: "4px 0", color: row[6]?.includes("flagged") ? colors.warn : colors.text,
          }}>
            {row.map((cell, j) => <div key={j} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cell}</div>)}
          </div>
        ))}
        <div style={{ marginTop: 12, color: colors.textDim, fontSize: 16 }}>... 189 more rows</div>
      </div>

      <div style={{
        display: "flex", gap: 16, marginTop: 32, opacity: tableOpacity,
      }}>
        {["nigeria-firs", "kenya-kra", "oecd-carf"].map((schema) => (
          <div key={schema} style={{
            background: colors.surface, border: `1px solid ${colors.accent}`,
            color: colors.accent, padding: "10px 20px", borderRadius: radius.sm,
            fontFamily: fonts.mono, fontSize: sizes.small, fontWeight: 600,
          }}>
            {schema}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
