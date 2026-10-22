import { useEffect, useState } from "react";
import type { RoomSnapshot } from "../shared/contracts";
import { scriptedAudience } from "../shared/audience";

export function useAudience(
  online: number,
  scenario?: RoomSnapshot["audienceScenario"],
) {
  const [seconds, setSeconds] = useState(scenario?.elapsedSeconds || 0);
  useEffect(() => {
    if (!scenario) return;
    const received = performance.now();
    const update = () =>
      setSeconds(
        scenario.elapsedSeconds + (performance.now() - received) / 1000,
      );
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [scenario]);
  return {
    seconds,
    count: scenario?.settings.enabled
      ? scriptedAudience(seconds, scenario.settings)
      : online,
  };
}
