import {
  Activity, AlertTriangle, Archive, ArrowLeft, ArrowRight, Ban, Bell, BellRing, Bookmark, Box, Boxes, Brain,
  Building2, Calendar, ChartBar, ChartBarStacked, ChartColumn, ChartColumnStacked, ChartLine, ChartPie,
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Circle, CircleDot, Clock, Cloud, Command, Copy, Cpu, Database, Donut, Download, ExternalLink, Eye, EyeOff, FileEdit, FileText, Folder,
  ChartNoAxesCombined, CodeXml, Bot, UserCog, LayoutGrid,
  Filter, Gauge, GitBranch, Globe, HardDrive, History, IdCard, Info, KeyRound, Layers, LayoutDashboard, LifeBuoy, Link2,
  List, Loader2, Lock, LogOut, Mail, Maximize2, MemoryStick, Menu, Minimize2, MessageSquare, Moon,
  MoreHorizontal, MoreVertical,
  Network, Palette, PartyPopper, Phone, Pin, Play, Plug, Plus, Power, Radio, RefreshCw, RotateCw, Route, Rows3, Save, ScrollText, Search, Server, Settings, Settings2,
  SendHorizontal, Shield, ShieldCheck, Sparkles, Square, Stethoscope, SunMedium, Table2, Terminal, Trash2, TrendingUp, Type, User, Users, Wifi, Wrench, X,
  Zap,
} from 'lucide-react';

/**
 * Central icon registry.
 *
 * Nav items and DB-driven menus refer to icons by NAME (a string), so the server
 * or a config file can pick an icon without importing React components. Adding
 * an icon = one line here.
 */
export const ICONS = {
  /* nav / modules */
  dashboard: LayoutDashboard,
  /* module-bar glyphs, named after the shape so the nav config reads literally */
  'layout-grid': LayoutGrid,
  'code-xml': CodeXml,
  'user-cog': UserCog,
  'chart-trend': ChartNoAxesCombined,
  bot: Bot,
  agent: Cpu,
  cpu: Cpu,
  server: Server,
  database: Database,
  cloud: Cloud,
  globe: Globe,
  brain: Brain,
  chat: MessageSquare,
  logs: ScrollText,
  report: FileText,
  shield: Shield,
  users: Users,
  user: User,
  key: KeyRound,
  mail: Mail,
  phone: Phone,
  'id-card': IdCard,
  celebrate: PartyPopper,
  building: Building2,
  history: History,
  settings: Settings,
  alert: AlertTriangle,
  desktop: HardDrive,
  layers: Layers,
  boxes: Boxes,
  terminal: Terminal,
  wrench: Wrench,
  activity: Activity,
  zap: Zap,
  trend: TrendingUp,
  table: Table2,
  rows: Rows3,
  lock: Lock,
  branch: GitBranch,
  archive: Archive,
  clock: Clock,
  memory: MemoryStick,
  network: Network,
  diagnose: Stethoscope,
  wifi: Wifi,
  box: Box,
  folder: Folder,
  route: Route,
  'shield-check': ShieldCheck,
  ban: Ban,
  power: Power,
  'eye-off': EyeOff,
  'file-edit': FileEdit,
  restart: RotateCw,
  settings2: Settings2,
  radio: Radio,

  /* chart-type picker */
  'chart-bar': ChartBar,
  'chart-bar-stacked': ChartBarStacked,
  'chart-column': ChartColumn,
  'chart-column-stacked': ChartColumnStacked,
  'chart-pie': ChartPie,
  'chart-donut': Donut,
  'chart-line': ChartLine,
  'chart-gauge': Gauge,
  'chart-meter': Rows3,
  gauge: Gauge,

  /* db technologies — no brand marks bundled, so these are semantic stand-ins */
  mysql: Database,
  postgres: Database,
  oracle: Database,
  mssql: Database,
  mongo: Database,
  clickhouse: Database,
  cosmos: Database,

  /* actions & chrome */
  search: Search,
  bell: Bell,
  'bell-ring': BellRing,
  palette: Palette,
  type: Type,
  menu: Menu,
  close: X,
  check: Check,
  plus: Plus,
  copy: Copy,
  play: Play,
  calendar: Calendar,
  save: Save,
  trash: Trash2,
  refresh: RefreshCw,
  download: Download,
  filter: Filter,
  eye: Eye,
  link: Link2,
  plug: Plug,
  list: List,
  more: MoreHorizontal,
  'more-vertical': MoreVertical,
  logout: LogOut,
  sun: SunMedium,
  moon: Moon,
  sparkles: Sparkles,
  send: SendHorizontal,
  stop: Square,
  command: Command,
  help: LifeBuoy,
  info: Info,
  pin: Pin,
  bookmark: Bookmark,
  external: ExternalLink,
  expand: Maximize2,
  collapse: Minimize2,
  spinner: Loader2,

  /* chevrons */
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevrons-left': ChevronsLeft,
  'chevrons-right': ChevronsRight,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,

  /* fallbacks */
  dot: CircleDot,
  circle: Circle,
};

/** Resolve a name to a component; unknown names degrade to a small circle. */
export const iconFor = (name) => ICONS[String(name || '').toLowerCase()] || Circle;

/**
 * <Icon name="database" size={18} />
 * `size` is in px and inherits currentColor, so tokens control the colour.
 */
export default function Icon({ name, size = 18, className, strokeWidth = 1.9, ...rest }) {
  const Cmp = iconFor(name);
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" {...rest} />;
}
