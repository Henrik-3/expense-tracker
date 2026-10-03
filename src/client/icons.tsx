type IconName = "capture" | "receipts" | "stats" | "categories" | "upload" | "check" | "arrow" | "shield";

const paths: Record<IconName, string> = {
  capture: "M8 5 9.5 3h5L16 5h4a1 1 0 0 1 1 1v13H3V6a1 1 0 0 1 1-1h4ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  receipts: "M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 7h6M9 11h6M9 15h3",
  stats: "M4 3v17h17M8 15v-4M13 15V7M18 15V4",
  categories: "M3 3h7v7H3V3ZM14 3h7v7h-7V3ZM3 14h7v7H3v-7ZM14 14h7v7h-7v-7Z",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  check: "m5 12 4 4L19 6",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  shield: "m12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6l8-3Zm-4 9 3 3 5-6",
};

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
