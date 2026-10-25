/**
 * Every primitive of the design system, once, in the current theme: `npm run dev:web -w
 * @open-inspect/demo-app`, then /design.html (`?theme=dark` for dark). A new primitive is added
 * here in the same change (`design-rules.test.ts` fails if one is missing).
 */

import { useState, type ReactNode } from "react";
import {
  Avatar,
  Badge,
  Button,
  Chip,
  FormField,
  IconButton,
  ListGroup,
  ListRow,
  NavRail,
  Notice,
  PageHeader,
  SegmentedControl,
  Sheet,
  Shimmer,
  StaticChip,
  SubPageHeader,
  TabBar,
  Tabs,
  TextArea,
  TextField,
} from "../ui/index.ts";
import {
  ArrowUp,
  ChatsIcon,
  Check,
  Coins,
  Download,
  FileIcon,
  Globe,
  MeIcon,
  Plus,
} from "../ui/icons.tsx";
import { ThemeToggle } from "../ThemeToggle.tsx";
import { useTheme } from "./theme.ts";
import "./Showcase.css";

const COLOURS = [
  "social-surface",
  "social-hover",
  "social-muted",
  "social-border",
  "social-divider",
  "social-fg",
  "social-fg-muted",
  "social-fg-subtle",
  "social-primary",
  "social-danger",
  "social-success",
  "social-warning",
];

const TYPE_SCALE = [
  ["display", "Display 32"],
  ["heading", "Heading 20"],
  ["title", "Title 16"],
  ["body", "Body 15"],
  ["small", "Small 13"],
  ["caption", "Caption 12"],
] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="showcase__section">
      <h2>{title}</h2>
      <div className="showcase__row">{children}</div>
    </section>
  );
}

export function Showcase() {
  const theme = useTheme();
  const [chip, setChip] = useState("one");
  const [tab, setTab] = useState("a");
  const [sheet, setSheet] = useState(false);
  const [segment, setSegment] = useState("light");
  const [page, setPage] = useState("chats");
  const navItems = [
    { key: "chats", label: "Chats", icon: (active: boolean) => <ChatsIcon filled={active} /> },
    { key: "me", label: "Me", icon: (active: boolean) => <MeIcon filled={active} /> },
  ];
  return (
    <main className="showcase">
      <header className="showcase__head">
        <h1>Demo Studio design system</h1>
        <ThemeToggle {...theme} />
      </header>

      <Section title="Colour tokens">
        {COLOURS.map((name) => (
          <div key={name} className="showcase__swatch">
            <span className="showcase__chip" style={{ background: `var(--${name})` }} />
            <code>--{name}</code>
          </div>
        ))}
      </Section>

      <Section title="Type scale">
        <div className="showcase__type">
          {TYPE_SCALE.map(([token, label]) => (
            <div
              key={token}
              style={{ fontSize: `var(--text-${token})`, lineHeight: `var(--leading-${token})` }}
            >
              {label}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Radius">
        {["tag 8", "field 12", "card 16", "pill"].map((name) => (
          <div
            key={name}
            className="showcase__radius"
            style={{ borderRadius: `var(--radius-${name.split(" ")[0]})` }}
          >
            {name}
          </div>
        ))}
      </Section>

      <Section title="Button">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
        <Button disabled>Disabled</Button>
        <Button href="#download">
          <Download /> As a link
        </Button>
      </Section>

      <Section title="IconButton">
        <IconButton label="Ghost">
          <Plus />
        </IconButton>
        <IconButton label="Muted" variant="muted">
          <Download />
        </IconButton>
        <IconButton label="Filled" variant="filled">
          <ArrowUp />
        </IconButton>
        <IconButton label="Small" size="sm">
          <Plus />
        </IconButton>
        <IconButton label="Disabled" variant="filled" disabled>
          <ArrowUp />
        </IconButton>
      </Section>

      <Section title="TextField, TextArea, FormField">
        <div className="showcase__form">
          <FormField label="Email" hint="We never send mail.">
            <TextField placeholder="you@example.com" />
          </FormField>
          <FormField label="Password" error="Use at least 8 characters.">
            <TextField type="password" invalid defaultValue="short" />
          </FormField>
          <TextField variant="pill" placeholder="Search" />
          <div className="showcase__card">
            <TextArea placeholder="Ask anything…" rows={2} />
          </div>
        </div>
      </Section>

      <Section title="Chip">
        {["one", "two", "three"].map((name) => (
          <Chip key={name} selected={chip === name} onClick={() => setChip(name)}>
            Choice {name}
          </Chip>
        ))}
        <StaticChip>Static</StaticChip>
      </Section>

      <Section title="Badge">
        <Badge>Default</Badge>
        <Badge variant="solid">Solid</Badge>
        <Badge variant="info">Info</Badge>
        <Badge variant="success" icon={<Check />}>
          Success
        </Badge>
        <Badge variant="warning">Warning</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <Badge icon={<Coins />}>1,956</Badge>
      </Section>

      <Section title="ListGroup, ListRow">
        <div className="showcase__form">
          <ListGroup>
            <ListRow
              icon={<Globe />}
              title="hello.html"
              subtitle="Open in preview"
              onClick={() => {}}
            />
            <ListRow icon={<FileIcon />} title="notes.md" trailing={<Badge>12 KB</Badge>} />
          </ListGroup>
          <div>
            <ListRow compact title="A conversation" selected onClick={() => {}} />
            <ListRow compact title="Another conversation" onClick={() => {}} />
          </div>
        </div>
      </Section>

      <Section title="Avatar">
        {["a", "b", "c", "d", "e", "f"].map((seed) => (
          <Avatar key={seed} seed={seed} />
        ))}
        <Avatar seed="small" size="sm" />
        <Avatar seed="large" size="lg" />
      </Section>

      <Section title="SegmentedControl">
        <SegmentedControl
          label="Example"
          value={segment}
          onChange={setSegment}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            { value: "system", label: "System" },
          ]}
        />
      </Section>

      <Section title="PageHeader, SubPageHeader">
        <div className="showcase__frame">
          <PageHeader
            title="Chats"
            actions={
              <IconButton label="New">
                <Plus />
              </IconButton>
            }
          />
          <SubPageHeader title="A conversation" subtitle="Ran on a computer" onBack={() => {}} />
        </div>
      </Section>

      <Section title="TabBar, NavRail">
        <div className="showcase__frame">
          <TabBar items={navItems} active={page} onSelect={setPage} />
        </div>
        <div className="showcase__frame showcase__frame--rail">
          <NavRail
            brand={<Avatar seed="brand" />}
            items={navItems.slice(0, 1)}
            footerItems={navItems.slice(1)}
            active={page}
            onSelect={setPage}
          />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          label="Example"
          selectedId={tab}
          onSelect={setTab}
          items={[
            { id: "a", label: "index.html", icon: <Globe /> },
            { id: "b", label: "notes.md", icon: <FileIcon /> },
          ]}
        />
      </Section>

      <Section title="Notice, Shimmer">
        <Notice>Saved.</Notice>
        <Notice tone="danger">You are out of credits.</Notice>
        <Shimmer>Thinking…</Shimmer>
      </Section>

      <Section title="Sheet">
        <Button variant="secondary" onClick={() => setSheet(true)}>
          Open a sheet
        </Button>
        <Sheet open={sheet} onClose={() => setSheet(false)} label="Example sheet">
          <div className="showcase__sheet">
            <p>Escape or a tap on the dim area closes it.</p>
            <Button onClick={() => setSheet(false)}>Close</Button>
          </div>
        </Sheet>
      </Section>
    </main>
  );
}
