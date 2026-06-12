// Scene 2: Problem — why this matters, 8s.
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { colors, fonts, sizes } from "../theme";
import { problem } from "../data";

const lines = [
  { icon: "👥", text: `${problem.audience} in ${problem.regions}` },
  { icon: "⚖️", text: `Crypto tax enforcement: ${problem.enforcement}` },
  { icon: "🚫", text: problem.gap },
];

export const ProblemScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const headerOpacity = interpolate(frame, [0, 0.6 * fps], [0, 1], {
    extrapolateRight: "clamp",
  });
  const headerX = interpolate(frame, [0, 0.8 * fps], [-40, 0], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ background: colors.bg, padding: 80, justifyContent: "center" }}>
      <div style={{
        fontFamily: fonts.display, fontSize: sizes.title, color: colors.accent,
        fontWeight: 800, opacity: headerOpacity, transform: `translateX(${headerX}px)`,
        marginBottom: 60,
      }}>
        The gap ↓
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
        {lines.map((line, i) => {
          const delay = 1.0 * fps + i * 0.8 * fps;
          const opacity = interpolate(frame, [delay, delay + 0.5 * fps], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          const slideX = interpolate(frame, [delay, delay + 0.5 * fps], [60, 0], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          });
          return (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 24,
              fontFamily: fonts.display, fontSize: sizes.subtitle, color: colors.text,
              opacity, transform: `translateX(${slideX}px)`,
            }}>
              <div style={{ fontSize: 48, width: 64 }}>{line.icon}</div>
              <div>{line.text}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
