import type { LucideIcon } from "lucide-react";
import {
  ArrowDownUp,
  ArrowLeftRight,
  ArrowUpRight,
  Banknote,
  Bed,
  Calendar,
  Car,
  ChartBar,
  ChartPie,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Code,
  Coffee,
  Download,
  Dumbbell,
  Ellipsis,
  ExternalLink,
  Fuel,
  Gift,
  GraduationCap,
  HeartPulse,
  House,
  Info,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LoaderCircle,
  Medal,
  Moon,
  Pencil,
  Pill,
  Plane,
  Plug,
  Plus,
  Receipt,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  ShoppingBag,
  ShoppingCart,
  SlidersHorizontal,
  Smartphone,
  Smile,
  Sparkles,
  Sun,
  Tag,
  Ticket,
  TrendingUp,
  TriangleAlert,
  Trash2,
  Tv,
  Undo2,
  Utensils,
  Wallet,
  Wifi,
  X,
  Zap,
} from "lucide-react";

/**
 * The app's single icon surface: semantic names → lucide glyphs (1.5px-stroke
 * family, tree-shaken). Call sites never import lucide directly — adding an
 * icon means adding one row here.
 */
const ICONS = {
  // navigation
  dashboard: LayoutDashboard,
  accounts: Landmark,
  imports: Download,
  transactions: ArrowDownUp,
  spending: ChartPie,
  budgets: ChartBar,
  recurring: RefreshCw,
  investments: TrendingUp,
  settings: Settings,
  sun: Sun,
  moon: Moon,
  // category identity
  banknote: Banknote,
  house: House,
  plug: Plug,
  utensils: Utensils,
  car: Car,
  plane: Plane,
  "shopping-bag": ShoppingBag,
  repeat: Repeat,
  "heart-pulse": HeartPulse,
  ticket: Ticket,
  smile: Smile,
  "graduation-cap": GraduationCap,
  gift: Gift,
  wallet: Wallet,
  receipt: Receipt,
  medal: Medal,
  "arrow-left-right": ArrowLeftRight,
  tag: Tag,
  "shopping-cart": ShoppingCart,
  coffee: Coffee,
  tv: Tv,
  code: Code,
  fuel: Fuel,
  key: KeyRound,
  bed: Bed,
  dumbbell: Dumbbell,
  pill: Pill,
  wifi: Wifi,
  smartphone: Smartphone,
  zap: Zap,
  // interface
  check: Check,
  close: X,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  plus: Plus,
  search: Search,
  filter: SlidersHorizontal,
  calendar: Calendar,
  more: Ellipsis,
  sparkles: Sparkles,
  "arrow-up-right": ArrowUpRight,
  undo: Undo2,
  "external-link": ExternalLink,
  edit: Pencil,
  delete: Trash2,
  warning: TriangleAlert,
  info: Info,
  "circle-check": CircleCheck,
  "circle-alert": CircleAlert,
  spinner: LoaderCircle,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** Runtime guard for icon names arriving from the database. */
export function isIconName(value: string | null | undefined): value is IconName {
  return typeof value === "string" && value in ICONS;
}

interface IconProps {
  name: IconName;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, className, strokeWidth = 1.75 }: IconProps) {
  const Glyph = ICONS[name];
  return <Glyph aria-hidden className={className ?? "size-4"} strokeWidth={strokeWidth} />;
}
