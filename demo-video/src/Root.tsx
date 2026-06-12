// Register the composition. 720p @ 24fps for low-spec host.
// Actual duration is computed by TransitionSeries in Agent06Demo (sum - transitions).
import { Composition } from "remotion";
import { Agent06Demo } from "./Agent06Demo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Agent06Demo"
      component={Agent06Demo}
      durationInFrames={1380}   // 6 scenes (1440) - 5 transitions (60) ≈ 1380
      fps={24}
      width={1280}
      height={720}
    />
  );
};
