import { cn } from "@/utils";
import { useEffect, useState } from "react";

const FRAMES = ["/images/mascot/captain.png", "/images/mascot/pirate.png"];

/** The Matelot crew: captain and pirate take turns, with a gentle bob (cross-fade every few seconds). */
export function Mascot({ size = 56, interval = 3500, className }: { size?: number; interval?: number; className?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), interval);
    return () => clearInterval(t);
  }, [interval]);
  return (
    <span className={cn("relative inline-block shrink-0 select-none motion-safe:animate-[mascot-bob_3s_ease-in-out_infinite]", className)} style={{ width: size, height: size }} aria-hidden="true">
      {FRAMES.map((src, i) => (
        <img key={src} src={src} alt="" draggable={false} className={cn("absolute inset-0 h-full w-full object-contain transition-opacity duration-700", i === frame ? "opacity-100" : "opacity-0")} />
      ))}
    </span>
  );
}
