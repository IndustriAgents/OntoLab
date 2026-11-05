import { IconSun, IconMoon } from "./icons";

interface Props {
  theme: "light" | "dark";
  onToggle: () => void;
}

export function ThemeToggle({ theme, onToggle }: Props) {
  return (
    <button className="icon-btn" onClick={onToggle} title="Toggle theme" aria-label="Toggle theme">
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
