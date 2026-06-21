# Memoria Design System

A design language for premium, dark-themed knowledge interfaces.

---

## Philosophy

> "Numbers are heroes, labels are whispers."

This system creates interfaces that feel like high-end personal analytics—calm, confident, and data-forward. Think Oura Ring, Arc Browser, Linear. The design should feel expensive without being flashy.

### Core Beliefs

1. **Hierarchy through restraint** — Size and opacity create importance, never color
2. **Data speaks first** — Large metrics dominate, supporting text recedes
3. **Sequential revelation** — Elements wake up one by one, never all at once
4. **Confident emptiness** — Whitespace is intentional, not leftover
5. **Invisible interaction** — Hover states reveal, not decorate

### Strict Rules

- **No Emojis** — Icons and typography convey meaning instead
- **No Accent Colors** — Monochromatic only (except entity graph)
- **No Gradients** — Flat colors with opacity variations
- **No Bold for Emphasis** — Size differential handles hierarchy
- **No Skeleton Loaders** — Staggered reveals instead

---

## Color Palette

### Monochromatic Scale
The palette moves from near-black backgrounds through ascending grays to white text. No accent colors. No gradients. No color-coding for categories or status.

```css
/* Backgrounds (darkest to lightest) */
bg-neutral-950        /* Main app background (#0a0a0a) */
bg-neutral-900/80     /* Sidebar, primary cards */
bg-neutral-900/60     /* Card backgrounds, containers */
bg-neutral-900/50     /* Overlay backgrounds */
bg-neutral-900/40     /* Light cards, questionnaire cards */
bg-neutral-800/60     /* Active states, icon containers */
bg-neutral-800/50     /* Hover states for cards */
bg-neutral-800/40     /* Selected cards, hover backgrounds */
bg-neutral-800/30     /* Subtle hover backgrounds */
bg-neutral-800/20     /* Very subtle hover states */
bg-neutral-800        /* Badges, tags, solid elements */
bg-neutral-700        /* Active pills, progress bars */

/* Borders */
border-neutral-800/60  /* Subtle borders (panels) */
border-neutral-800     /* Default borders */
border-neutral-700     /* Hover states, active states */
border-neutral-600     /* Focus/highlight states */

/* Text Hierarchy (5 opacity levels) */
text-white             /* Primary text, hero numbers, titles */
text-neutral-200       /* Secondary text, descriptions */
text-neutral-300       /* Body text, markdown content */
text-neutral-400       /* Muted text, icons, timestamps */
text-neutral-500       /* Timestamps, hints, labels */
text-neutral-600       /* Placeholders, very muted text */
```

### Effect Colors
```css
/* Border Beams */
from-transparent via-neutral-500 to-transparent      /* Modal beam */
from-neutral-600/40 via-neutral-500/40 to-neutral-600/40  /* Standard beam */
from-neutral-600/30 via-neutral-400/40 to-neutral-600/30  /* Selection beam */

/* Glare Effects */
rgba(255,255,255,0.15)  /* Glare center */
rgba(255,255,255,0.05)  /* Glare mid */
rgba(255,255,255,0)     /* Glare edge */

/* Destructive (delete actions only) */
hover:bg-red-500/20
hover:text-red-400
hover:border-red-500/40
```

### Entity Graph Colors (Exception)
The entity graph is the one place where color appears. Node types have distinct but muted, desaturated colors that feel cohesive with the monochromatic system.

---

## Typography

Light, not bold. Large numbers and headlines use light font weights. This creates elegance at scale.

### Font Weights
```css
font-light       /* Hero stats (3xl-6xl numbers), main titles - PREFERRED for large text */
font-normal      /* Body text default */
font-medium      /* Item titles, badges, buttons */
font-semibold    /* Important labels, type tags, markdown headings */
/* font-bold is avoided for emphasis — size handles hierarchy */
```

### Font Size Scale
```css
text-[9px]       /* Very small labels */
text-[10px]      /* Tags, timestamps, progress indicators */
text-[11px]      /* Small metadata, source labels */
text-xs          /* Descriptions, metadata (12px) */
text-sm          /* Item titles, body text (14px) */
text-base        /* Modal titles, section headers (16px) */
text-lg          /* Page titles (18px) */
text-xl          /* Card titles on hover */
text-2xl         /* Activity totals */
text-3xl-6xl     /* Hero stats (responsive) */
```

### Letter Spacing
Uppercase whispers. Section labels are small, uppercase, and widely tracked.

```css
tracking-tight     /* Hero stats, main numbers */
tracking-wide      /* Body text emphasis */
tracking-wider     /* Labels ("14-Day Activity") */
tracking-widest    /* Uppercase labels ("Step 1 of 5") */
tracking-[0.2em]   /* Questionnaire progress labels */
```

### Text Transforms
```css
uppercase          /* Tags, type badges, progress labels, section headers */
capitalize         /* Chat titles */
lowercase          /* Formatting normalization */
```

### Hierarchy Examples
| Element | Size | Weight | Color | Tracking |
|---------|------|--------|-------|----------|
| Hero numbers | 3xl-6xl | light | white | tight |
| Page titles | lg-xl | light | white | normal |
| Card counts | 2xl | light | white | tight |
| Section labels | xs | medium | neutral-500 | widest, uppercase |
| Body text | sm | normal | neutral-300 | normal |
| Metadata | [10px]-xs | normal | neutral-500 | normal |

---

## Animation System

### Core Philosophy: Sequential Revelation
When a view loads, elements appear sequentially—hero content first, then supporting sections, then list items one by one. The interface "wakes up."

### Signature Easing Curves
```tsx
[0.25, 0.46, 0.45, 0.94]  /* Main page transitions (smooth deceleration) */
[0.25, 0.1, 0.25, 1]      /* Questionnaire animations */
[0.4, 0, 0.2, 1]          /* Accordion expand/collapse */
[0.16, 1, 0.3, 1]         /* GlowingEffect movement */
type: "spring"            /* Tabs, modals (bounce: 0.2-0.3, stiffness: 260, damping: 15) */
```

### Page Transitions (Blur-to-Clear)
Headlines and pages animate from blurred to sharp. This creates a sense of focus emerging.

```tsx
initial={{ opacity: 0, filter: 'blur(10px)' }}
animate={{ opacity: 1, filter: 'blur(0px)' }}
exit={{ opacity: 0, filter: 'blur(5px)' }}
transition={{ duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] }}
```

### Text Generate Effect (Word-by-Word)
Words animate in with staggered blur-to-clear:

```tsx
initial={{ opacity: 0, filter: 'blur(8px)' }}
animate={{ opacity: 1, filter: 'blur(0px)' }}
stagger: 0.08s (fast) or 0.2s (dramatic)
duration: 0.4s
```

### Card/List Animations (Staggered Entry)
```tsx
// Standard entry
initial={{ opacity: 0, y: 20 }}
animate={{ opacity: 1, y: 0 }}
exit={{ opacity: 0, y: -10 }}
transition={{ duration: 0.3, delay: index * 0.05 }}  /* Stagger by index */

// Hover
whileHover={{ scale: 1.01 }}  /* Subtle lift */
whileHover={{ scale: 1.02 }}  /* Compact cards */
```

### Accordion/Expand Animations
```tsx
initial={{ height: 0, opacity: 0 }}
animate={{ height: "auto", opacity: 1 }}
exit={{ height: 0, opacity: 0 }}
transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
```

### Modal Animations (Spring-based 3D)
```tsx
initial={{ opacity: 0, scale: 0.5, rotateX: 40, y: 40 }}
animate={{ opacity: 1, scale: 1, rotateX: 0, y: 0 }}
exit={{ opacity: 0, scale: 0.8, rotateX: 10 }}
transition={{ type: "spring", stiffness: 260, damping: 15 }}
```

### Tab Indicator (Shared Layout)
```tsx
layoutId="activeTab"
transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
```

### Animated Counter (Growth, Not Pop)
Numbers count up. Things build rather than appear.

```tsx
duration: 1000ms
steps: 30
increment: value / steps
```

### Progress Bar Growth
```tsx
initial={{ width: 0 }}
animate={{ width: `${percentage}%` }}
transition={{ duration: 0.6, ease: [0.25, 0.1, 0.25, 1] }}

// Activity bars (staggered)
transition={{ duration: 0.5, delay: 0.8 + idx * 0.04 }}
```

### Loading States
```tsx
// Spinner
"w-6 h-6 border-2 border-neutral-600 border-t-transparent rounded-full animate-spin"

// Rotating refresh
className={cn("w-5 h-5", loading && "animate-spin")}

// Disabled
"opacity-50 cursor-not-allowed"
```

---

## UI Components

### BorderBeam
Animated border effect that travels around card edges. A traveling highlight that adds premium feel without color.

```tsx
// Modal beam (prominent)
<BorderBeam duration={4-6} size={380-400} borderWidth={2} 
  className="from-transparent via-neutral-500 to-transparent" />

// Card selection beam (subtle)
<BorderBeam size={150} duration={8} borderWidth={1} 
  className="from-neutral-600/30 via-neutral-400/40 to-neutral-600/30" />

// Double beam effect (staggered)
<BorderBeam duration={4} delay={0} size={400} borderWidth={2} />
<BorderBeam duration={4} delay={1} size={400} borderWidth={2} />
```

### ProgressiveBlur
Essential component for scroll containers. Creates depth by fading content at edges.

```tsx
<ProgressiveBlur
  height="60px"           /* 60-80px typical */
  position="bottom"       /* or "top" */
  className="pointer-events-none"
/>
```

**Required for all scrollable containers:**
```tsx
<div className="relative flex-1 min-h-0">
  <div className="absolute inset-0 overflow-y-auto pb-16">
    {/* Scrollable content */}
  </div>
  <ProgressiveBlur height="80px" position="bottom" className="pointer-events-none" />
</div>
```

### 3D Card Glare Effect
Premium hover effect with perspective rotation and light reflection.

```tsx
// 3D rotation based on mouse position
transform: `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`
rotateY: ((x - 50) / 50) * 3    /* max 3 degrees */
rotateX: ((y - 50) / 50) * -2   /* max 2 degrees, inverted */
transition: 'transform 0.2s ease-out'

// Glare overlay gradient (follows cursor)
background: `radial-gradient(circle at ${x}% ${y}%, 
    rgba(255,255,255,0.15) 0%, 
    rgba(255,255,255,0.05) 40%, 
    rgba(255,255,255,0) 70%)`
opacity: 0.15 (on hover)

// Shimmer layer
mix-blend-mode: overlay
opacity: glareStyle.opacity * 1.5
```

### Focus-Blur Pattern
When one card is hovered, siblings blur to create focus.

```tsx
const isBlurred = hoveredIndex !== null && hoveredIndex !== index;

className={cn(
    "transition-all duration-300 ease-out",
    isBlurred && "blur-sm scale-[0.98] opacity-60"
)}
```

### LampContainer
Dramatic lighting effect. **Used exclusively in onboarding** for hero moments.

### OrbitingCircles
Animated orbiting elements. Used in onboarding to show supported AI platforms.

### StarsBackground & ShootingStars
Ambient background effects. Always at z-0, content at z-10+.

### TextGenerateEffect
Staggered word-by-word text reveal animation with blur-to-clear.

---

## Layout Patterns

### Generous Breathing Room
Sections have significant vertical spacing. Cards have comfortable internal padding. Lists have relaxed row heights.

```css
/* Spacing Scale */
gap-2           /* Icon buttons, small elements */
gap-3           /* Item groups, navigation */
gap-4           /* Dashboard cards */
gap-6           /* Page sections */

/* Padding Scale */
p-2 / p-2.5     /* Small items */
p-3             /* Compact cards */
p-4             /* Standard cards */
p-5             /* Questionnaire cards */
p-6             /* Page padding, modal content */
```

### Border Radius Scale
```css
rounded-lg      /* Small cards, buttons (8px) */
rounded-xl      /* Standard cards (12px) */
rounded-2xl     /* Large cards, modals (16px) */
rounded-full    /* Pills, tabs, badges */
```

### Bento-Style Grids
Content cards arrange in flexible grids—not rigid columns. Cards can span different widths.

```tsx
// ChatDetail example
Summary: ~50% height
Memories + Entities: split remaining 50% side-by-side
// Expandable sections with smooth transitions
```

### Master-Detail Pattern
Lists on the left, detail on the right. The selected state is subtle—a slightly lighter background or border change.

### Scroll Container Pattern
**All scrollable lists must have ProgressiveBlur:**

```tsx
<div className="relative flex-1 min-h-0">
  <div className="absolute inset-0 overflow-y-auto pb-16">
    {/* Content with adequate bottom padding */}
  </div>
  <ProgressiveBlur 
    height="80px" 
    position="bottom" 
    className="pointer-events-none absolute bottom-0 left-0 w-full" 
  />
</div>
```

### Sticky Headers
Page titles stay visible. Counts update in headers so users always know where they are.

---

## Tech Stack

### Frontend
- **React** - UI framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Utility-first styling
- **motion/react** (Framer Motion) - Animations
- **Aceternity UI** - Premium UI components
- **react-markdown** - Markdown rendering
- **Tabler Icons** - Icon library
- **Lucide React** - Additional icons

### Backend (Electron Main Process)
- **Electron** - Desktop application framework
- **better-sqlite3** - SQLite database
- **electron-vite** - Build tooling

### AI Integrations
The app monitors and extracts conversations from:
- Claude (Desktop & Web)
- ChatGPT
- Gemini
- Perplexity
- Grok

---

## Interactive States

### Hover States

#### Cards & Items
```tsx
// Border brightens
hover:border-neutral-700  /* From border-neutral-800 */

// Background shifts
hover:bg-neutral-800/60
hover:bg-neutral-800/50
hover:bg-neutral-800/40
hover:bg-neutral-800/30
hover:bg-neutral-800/20

// Text brightens
hover:text-white          /* From text-neutral-400 */
hover:text-neutral-300    /* From text-neutral-500 */

// Subtle scale
whileHover={{ scale: 1.01 }}
```

#### Reveal on Hover
Interactive elements show affordances on hover—arrows appear, text brightens, borders highlight.

```tsx
// Arrow/icon fade in
opacity-0 group-hover:opacity-100 transition-opacity

// Action hints appear
className="opacity-0 group-hover:opacity-100"
```

### Focus States
```tsx
focus:outline-none
focus:border-neutral-600           /* Input fields */
focus:ring-1 focus:ring-neutral-500/50  /* Dropdowns */
focus-visible:ring-2 focus-visible:ring-neutral-500/40  /* Cards */
```

### Selected States
Subtle—a slightly lighter background or border change.

```tsx
// Selected card
"bg-neutral-800/40 border-neutral-700"

// With BorderBeam
{isSelected && <BorderBeam size={150} duration={8} borderWidth={1} />}

// Highlight ring
"ring-2 ring-neutral-500 ring-offset-2 ring-offset-neutral-950"
```

### Destructive States (Delete only)
```tsx
hover:bg-red-500/20
hover:text-red-400
hover:border-red-500/40
```

---

## Component Catalog

### Cards
Cards are containers, not decorations. Subtle borders, transparent backgrounds, comfortable padding.

```tsx
// Standard card
"bg-neutral-900/60 border border-neutral-800 rounded-xl p-4 hover:border-neutral-700"

// Featured card (with beam)
<div className="relative bg-neutral-900/60 border border-neutral-800 rounded-xl p-4">
  {content}
  <BorderBeam size={200} duration={10} borderWidth={1.5} />
</div>

// Item variants
default: "border-neutral-800 bg-neutral-900/50 hover:bg-neutral-900/80"
outline: "border-neutral-800 bg-transparent hover:bg-neutral-900/30"
muted: "border-neutral-800/60 bg-neutral-900/30 hover:bg-neutral-900/60"
```

### Lists
List items have generous vertical padding and hairline dividers. Last item has no divider.

```tsx
// List item
"p-4 border-b border-neutral-800/50 last:border-b-0 hover:bg-neutral-800/30"

// With hover arrow
<div className="group flex items-center justify-between">
  <span>{title}</span>
  <IconArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
</div>
```

### Hero Stats
Large numbers centered with tiny labels beneath. Numbers animate up from zero.

```tsx
<div className="text-center">
  <AnimatedCounter value={count} className="text-4xl font-light text-white tracking-tight" />
  <span className="text-xs text-neutral-500 uppercase tracking-widest">Label</span>
</div>
```

### Badges & Tags

```tsx
// Type tag (uppercase)
"px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-neutral-800 text-neutral-300 border border-neutral-700"

// Count pill
"px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700"

// Simple badge
"px-1.5 py-0.5 rounded bg-neutral-800/50 text-neutral-600"
```

### Buttons

```tsx
// Primary button
"bg-neutral-800 border border-neutral-700 text-white hover:bg-neutral-700 hover:border-neutral-600 rounded-lg px-4 py-2"

// Icon button (square)
"h-8 w-8 rounded-lg border border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-white hover:border-neutral-700"

// Panel button (larger)
"h-[42px] w-[42px] rounded-xl border border-neutral-800/60 bg-neutral-900/50"
```

### Inputs

```tsx
// Text input
"w-full pl-10 pr-4 py-3 rounded-xl bg-neutral-900/80 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-600 transition-colors"

// Search with icon
<div className="relative">
  <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-500" />
  <input className="pl-10 ..." placeholder="Search..." />
</div>
```

### Tabs & Filters
Pill-style with subtle backgrounds. Active state has sliding indicator.

```tsx
// Tab bar
"flex gap-1 p-1 rounded-full bg-neutral-900/60 border border-neutral-800"

// Tab item
"px-4 py-2 rounded-full text-sm transition-colors"
// Active: with layoutId indicator
// Inactive: "text-neutral-400 hover:text-neutral-200"

// Active indicator
<motion.div layoutId="activeTab" className="absolute inset-0 bg-neutral-800/80 rounded-full" />
```

### Modals
Centered card on dimmed backdrop. Simple header with title and close.

```tsx
// Backdrop
"fixed inset-0 bg-black/60 backdrop-blur-sm z-50"

// Modal container
"bg-neutral-900 border border-neutral-800 rounded-2xl p-6 max-w-lg w-full"

// With animation
initial={{ opacity: 0, scale: 0.5, rotateX: 40, y: 40 }}
animate={{ opacity: 1, scale: 1, rotateX: 0, y: 0 }}
```

### Empty States
Centered icon in a rounded container, title below, description beneath.

```tsx
<div className="h-full flex flex-col items-center justify-center text-center px-4">
  <div className="w-16 h-16 rounded-2xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-4">
    <Icon className="w-8 h-8 text-neutral-600" />
  </div>
  <p className="text-neutral-400 text-lg font-medium mb-2">Title</p>
  <p className="text-neutral-600 text-sm max-w-md">Description</p>
</div>
```

### Data Visualizations
Minimal. No gridlines, no axis labels, no legends unless essential.

```tsx
// Activity bar
"h-full bg-neutral-700 rounded-sm"
initial={{ height: 0 }}
animate={{ height: `${value}%` }}

// Distribution bar (horizontal)
<div className="flex h-2 rounded-full overflow-hidden bg-neutral-800">
  {segments.map((s, i) => (
    <div 
      key={i}
      className="h-full" 
      style={{ 
        width: `${s.percent}%`,
        backgroundColor: `rgba(255,255,255,${0.6 - i * 0.15})` /* Descending grays */
      }} 
    />
  ))}
</div>
```

### Scroll Container Pattern
**All scrollable content requires ProgressiveBlur:**

```tsx
<div className="relative flex-1 min-h-0">
  <div className="absolute inset-0 overflow-y-auto pb-16">
    {/* Content */}
  </div>
  <ProgressiveBlur height="80px" position="bottom" className="pointer-events-none" />
</div>
```

---

## Sidebar Navigation

- Collapsible sidebar using Aceternity Sidebar component
- Icon + label with animated show/hide
- Active state: `bg-neutral-800 text-white`
- Hover state: `bg-neutral-800/50 hover:text-white`

---

## Component Hierarchy

```
App.tsx
├── StarsBackground (z-0)
├── ShootingStars (z-0)
├── Sidebar
│   └── SidebarBody (navigation items)
├── Tab Bar
└── Content Area (AnimatePresence, z-10)
    ├── Dashboard
    ├── ChatList → ChatDetail
    ├── MemoryList
    ├── EntityList
    ├── EntityGraph
    └── MemoryChat
```

---

## Iconography

### Usage Rules
- Sparse and functional—icons appear for navigation, actions, and metadata counts
- They never decorate
- Small and muted by default, brightening on hover or when active

### Sizing
```css
w-4 h-4      /* Inline icons, metadata */
w-5 h-5      /* Interactive icons, buttons */
w-6 h-6      /* Navigation icons */
w-8 h-8      /* Empty state icons */
```

---

## Content Guidelines

### Truncation
Long titles truncate with ellipsis. Long descriptions clamp to 2-3 lines.

```css
truncate                    /* Single line ellipsis */
line-clamp-2               /* 2 lines max */
line-clamp-3               /* 3 lines max */
```

### Number Formatting
Large numbers use locale formatting (commas/periods). Numbers in tables align with tabular figures.

### Timestamps
Relative when recent: "2 hours ago" not "1/20/2026, 2:00 PM" for recent items. Full timestamps for older content.

---

## Voice & Tone

The interface speaks quietly:
- Labels are terse: "Memories" not "Your Saved Memories"
- Descriptions are brief
- Empty states are encouraging but not chatty
- Error messages are clear and actionable
- Nothing is exclamatory

---

## Quality Checklist

Before considering a screen complete:

- [ ] Does hierarchy come from size and opacity alone?
- [ ] Are large numbers using light weight, not bold?
- [ ] Are labels small, uppercase, and widely tracked?
- [ ] Is metadata appropriately tiny?
- [ ] Do animations stagger sequentially?
- [ ] Do hover states reveal rather than decorate?
- [ ] Is there generous whitespace between sections?
- [ ] Are there zero accent colors (except graph nodes)?
- [ ] Do all scroll containers have ProgressiveBlur?
- [ ] Do cards have the 3D glare effect on hover?
- [ ] Is the overall feeling calm and premium?

---

## Allowed vs Not Allowed

### ✓ Allowed
- Monochromatic grays from near-black to white
- Light font weights for large text
- Uppercase labels with wide letter-spacing
- Semi-transparent backgrounds
- Subtle, barely-visible borders
- Staggered sequential animations
- Blur-to-clear text reveals
- Growing bars and counting numbers
- Hover states that brighten or reveal
- Generous whitespace
- ProgressiveBlur on all scroll containers
- 3D card glare effects
- BorderBeam for featured/selected cards
- Muted categorical colors in the graph only

### ✗ Not Allowed
- Accent colors for emphasis or status
- Gradients anywhere
- Bold text for emphasis
- Heavy or prominent borders
- Solid opaque card backgrounds
- Simultaneous animations (everything at once)
- Decorative icons
- Skeleton loading states
- Complex loading indicators
- Emojis
- Color-coded badges or tags (except graph node types)
- Gridlines or axis labels on charts
- Drop shadows (except very subtle on modals)

---

## Badge & Tag Reference

### Standard Badge
```tsx
className="bg-neutral-800 text-neutral-400 border border-neutral-700"
```

### Count Pill
```tsx
className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-neutral-700 text-neutral-300"
```

### Type Tag
```tsx
className="px-2 py-0.5 text-[10px] font-semibold uppercase rounded bg-neutral-800 text-neutral-400 border border-neutral-700"
```

---

## Input & Button Reference

### Text Input
```tsx
className="bg-neutral-900/80 border border-neutral-800 text-white placeholder-neutral-600 focus:outline-none focus:border-neutral-600"
```

### Primary Button
```tsx
className="bg-neutral-800 border border-neutral-700 text-white hover:bg-neutral-700 hover:border-neutral-600"
```

### Icon Button
```tsx
className="p-2 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700"
```

---

## Empty State Reference

Centered layout with muted icon and text:
```tsx
<div className="h-full flex flex-col items-center justify-center text-center px-4">
  <div className="w-16 h-16 rounded-2xl bg-neutral-800 border border-neutral-700 flex items-center justify-center mb-4">
    <Icon className="w-8 h-8 text-neutral-600" />
  </div>
  <p className="text-neutral-400 text-lg font-medium mb-2">Title</p>
  <p className="text-neutral-600 text-sm max-w-md">Description</p>
</div>
```

---

## Best Practices Summary

1. **Consistency** - Always use the neutral palette, never introduce colors
2. **Hierarchy** - Use opacity and size to create visual hierarchy, not color
3. **Animations** - Keep animations subtle (0.3-0.5s), use blur-to-clear for polish
4. **Spacing** - Use consistent padding (p-4 for cards, p-6 for page content)
5. **Borders** - Default `border-neutral-800`, hover `border-neutral-700`
6. **Backdrop Blur** - Use `backdrop-blur-xl` or `backdrop-blur-sm` for depth
7. **Z-Index** - Stars at z-0, content at z-10, overlays higher
8. **Scroll** - Always add ProgressiveBlur to scrollable containers
9. **Cards** - Add 3D glare effect for premium feel
10. **Selection** - Use BorderBeam for selected/featured items

---

## File Structure

```
src/renderer/src/
├── components/
│   ├── ui/           # Aceternity & shared UI components
│   │   ├── border-beam.tsx
│   │   ├── progressive-blur.tsx
│   │   ├── text-generate-effect.tsx
│   │   ├── sidebar.tsx
│   │   ├── stars-background.tsx
│   │   ├── shooting-stars.tsx
│   │   ├── lamp.tsx
│   │   └── orbiting-circles.tsx
│   ├── Dashboard.tsx
│   ├── ChatList.tsx
│   ├── ChatDetail.tsx
│   ├── MemoryList.tsx
│   ├── MemoryChat.tsx
│   ├── EntityList.tsx
│   ├── EntityGraph.tsx
│   └── Onboarding.tsx
├── lib/
│   └── utils.ts      # cn() utility for classnames
└── assets/
    └── main.css      # Tailwind config
```
