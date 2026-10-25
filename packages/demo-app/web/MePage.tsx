import type { User } from "./api.ts";
import type { ThemePreference, ThemeControl } from "./design/theme.ts";
import { Avatar, Badge, ListGroup, ListRow, PageHeader, SegmentedControl } from "./ui/index.ts";
import { Coins } from "./ui/icons.tsx";
import "./MePage.css";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export interface MePageProps {
  user: User;
  theme: ThemeControl;
  onSignOut: () => void;
}

/** The account: who is signed in, the credits, the theme, sign out. */
export function MePage({ user, theme, onSignOut }: MePageProps) {
  return (
    <section className="me">
      <PageHeader title="Me" />
      <div className="me__body">
        <div className="me__profile">
          <Avatar seed={user.id} size="lg" />
          <div className="me__email" title={user.email}>
            {user.email}
          </div>
        </div>
        <ListGroup>
          <ListRow
            icon={<Coins />}
            title="Credits"
            subtitle="New prompts are refused at zero"
            trailing={
              <Badge variant={user.credits > 0 ? "default" : "destructive"}>
                {user.credits.toLocaleString()}
              </Badge>
            }
          />
          <ListRow
            title="Theme"
            trailing={
              <SegmentedControl
                label="Theme"
                options={THEME_OPTIONS}
                value={theme.preference}
                onChange={theme.setPreference}
              />
            }
          />
        </ListGroup>
        <ListGroup>
          <ListRow
            title="About"
            subtitle="Demo Studio is a reference product on Mate Agent. Accounts live on this machine only."
          />
        </ListGroup>
        <ListGroup>
          <ListRow title="Sign out" destructive onClick={onSignOut} />
        </ListGroup>
      </div>
    </section>
  );
}
