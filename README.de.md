<!-- golive-translation: lang=de; source=README.md; source-commit=0fc6dca; reviewed=false; updated=2026-09-26 -->
# GoLive

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · [Deutsch](README.de.md)

**Bring das Produkt, das dein Agent gebaut hat, live: Hosting, Datenbank, Auth, Domain, E-Mail, Zahlungen — auf deinen eigenen Konten. Danach übergibst du es oder reißt alles wieder ab.**

Dein Coding-Agent baut eine App in Minuten. Bis sie bei echten Nutzern ankommt, brauchst du trotzdem
Konten, Hosting, Datenbanken, Domains, Secrets und verbundene Dienste. GoLive ist der quelloffene
Agent Skill für genau diese Arbeit: Er **erkennt, was deine App braucht, plant die konkreten
Änderungen, holt deine Freigabe ein, führt sie mit deinen eigenen Logins aus und prüft, was
tatsächlich funktioniert** — danach hält er fest, was er angelegt hat, prüft es auf Wunsch erneut
auf Drift und kann es wieder entfernen.

Automatisieren, was die Provider anbieten. Dich durch die Teile führen, die einen Menschen brauchen.
Prüfen, was sich beobachten lässt, und unfertige Arbeit sichtbar machen. Kein GoLive-Konto, kein
gehostetes Backend, keine Produkt-Telemetrie.

> **Frühe Alpha · 0.1.0-alpha.4**
> Wegwerf-Livetests decken jetzt sechs Abläufe ab: **Hosting** (Vercel, Netlify), **Datenbank**
> (Supabase, Neon), **DNS für eigene Domains** (Porkbun, GoDaddy), **Transaktions-E-Mail** (Resend),
> **Zahlungen im Testmodus** (Stripe) und **Supabase-Authentifizierung**, dazu den
> Deinstallationspfad `teardown`. Das Eigentumsdokument und die Drift-Prüfung `golive status` auf
> Abruf sind mit Testabdeckung implementiert (`golive status` lief außerdem in einer Live-Validierung
> schreibgeschützt), während die breitere
> [Roadmap](README.md#the-full-go-live-checklist-and-roadmap) unsere Richtung beschreibt und nicht
> die Behauptung ist, dass schon alles gebaut ist.

## Bevor du Produktionszugang übergibst

Ob ein Agent Zugriff auf deine Provider-Konten bekommt, läuft auf vier Fragen hinaus. Hier stehen die
Antworten dieses Projekts — mit den Grenzen dort, wo es sie gibt.

- **Jeden Schreibvorgang gibst weiterhin du frei.** Nichts erreicht ein echtes Konto ohne einen Plan,
  den du gesehen und freigegeben hast: `apply` verweigert ohne die ID dieses Plans und ohne `--yes`
  und prüft die Identität des Plans vor dem Schreiben erneut, sodass ein geändertes Release oder eine
  geänderte Konfiguration die alte Freigabe ungültig macht. DNS-Schreibvorgänge brauchen
  `--confirm-dns`, Löschungen brauchen `--confirm-destroy`, und Schritte im Live-Modus — Live-Zahlungen,
  Produktionsdaten, ein echtes Konto — brauchen `--confirm-live`, was inzwischen auch das **erste
  Produktions-Deployment** eines Projekts einschließt, denn früher reichte die Freigabe eines Plans
  allein aus, um zum ersten Mal in die Produktion zu schreiben. Credential-Werte werden nur im Prozess
  gelesen, nie ausgegeben und erscheinen nie in Argumenten, Plänen, State oder Berichten; die Datei, in
  der golive sie ablegt, ist Klartext mit Modus 0600 außerhalb deines Repos, kein Keychain. Eine
  Grenze, die man benennen sollte: Diese Flags sind Argumente, die der Agent in deinem Namen übergibt,
  und ein Agent, der bei deinem Provider bereits angemeldet ist, kann dort ganz ohne golive-Plan
  schreiben. [Vertrauen, Zugriff und Kontrolle](docs/TRUST.md) trennt, was der Code erzwingt, von dem,
  was nur eine Anweisung ist, die der Agent befolgen soll.
- **Ein Lauf hält an, statt weiterzudrücken.** `apply` stoppt beim ersten fehlgeschlagenen Check, bei
  einer fehlenden Bestätigung, bei einer fehlenden Voraussetzung oder bei einem Provider, der dem Plan
  widerspricht. Spätere Schritte laufen dann nicht, und das nächste `apply` setzt bei diesem Schritt
  wieder auf. [Wiederherstellung](docs/RECOVERY.md#the-run-stopped) beschreibt, wie man den Fehler
  liest, welche Schritte wiederaufgenommen werden und welche Fälle zuerst eine geprüfte Entscheidung
  brauchen.
- **Rollback ist eng, optional und nie automatisch.** Ein fehlgeschlagener Check löst nie einen
  Rollback aus. `release.rollback: true` plant einen Schritt, der die Produktion auf ein früheres
  Deployment umlenkt, das golive selbst aufgezeichnet hat; ein Deployment, das über ein Dashboard,
  einen Git-Push oder einen Pull Request entstanden ist, ist kein Ziel, und der Schritt berührt keine
  Daten-, DNS-, Zahlungs- oder E-Mail-Ressource. Nur Netlify unterstützt dieses Umlenken derzeit — auf
  Vercel korrigierst du die Produktion im Dashboard (Vercels Adapter kann nicht lesen, was die
  Produktion ausliefert). Promotion und Rollback sind implementiert und mock-abgedeckt, **nicht live
  validiert**.
- **Nichts bleibt still zurück — was nicht bedeutet, dass nichts zurückbleibt.** `golive
  teardown` entfernt nur Ressourcen, von denen es belegen kann, dass es sie angelegt hat, liest nach
  dem Löschen die DNS-Zone und das Host-Projekt erneut und benennt jeden Rest, den es nicht entfernen
  kann — Supabase- und Neon-Projekte, die Resend-Versanddomain, eine Zone oder ein Host-Projekt ohne
  Leserechte — in einem Handoff, der sagt, was übrig bleibt und wie man es von Hand entfernt. Eine
  Entfernung vergisst außerdem die Baseline, die golive für diese Ressource aufgezeichnet hat, damit
  `golive status` golives eigenen Teardown nicht als Drift meldet.

Diese Antworten in voller Länge: [Vertrauen, Zugriff und Kontrolle](docs/TRUST.md) und
[Wiederherstellung](docs/RECOVERY.md). Die [Architektur](docs/ARCHITECTURE.md) ist der Produktvertrag,
der [Provider-Umfang](docs/PROVIDERS.md) sagt, was jeder Provider heute kann, das
[Validierungsprotokoll](docs/VALIDATION.md) trennt, was live erprobt wurde, von dem, was nur
mock-abgedeckt ist, und [Installation und Updates](docs/DISTRIBUTION.md) behandelt Installation und
Aktualisierung.

[Installation](README.md#install) · [GoLive benutzen](README.md#use-golive) · [Den Workflow ansehen](README.md#what-a-run-looks-like) · [Alpha-Umfang](README.md#what-this-alpha-supports) · [Roadmap](README.md#the-full-go-live-checklist-and-roadmap) · [Mitwirken](CONTRIBUTING.md)

## Installation

Du brauchst **Node.js 20+**, npm/npx, Git und einen Coding-Agenten, der Skills laden und Befehle
ausführen kann. Die Installation ist für Codex und Claude Code geprüft; andere Clients sind nicht
verifiziert.

**Einmal für alle deine Projekte installieren.** Führe das in einem beliebigen Verzeichnis aus:

```bash
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global
```

Wähle deinen Agenten, wenn du gefragt wirst: Pfeiltasten zum Bewegen, Leertaste zum Auswählen, Enter
zum Bestätigen. Dieser Bildschirm wartet auf eine Eingabe; die Installation läuft erst nach deiner
Bestätigung weiter.

Um die Agenten-Auswahl zu überspringen, nimm den Befehl für deinen Agenten:

```bash
# Codex
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent codex --yes

# Claude Code
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global --agent claude-code --yes
```

Für die Installation in nur einem Projekt führst du den Befehl im Repository dieses Projekts aus und
lässt `--global` weg.

**Oder füge das in deinen Coding-Agenten ein:**

```text
Install the GoLive skill globally so I can use it across projects:
npx skills add https://github.com/mikehasa/golive-skill --skill golive --global

Target the agent I'm using: add --agent codex --yes for Codex, or
--agent claude-code --yes for Claude Code. Keep --global.
If the agent isn't clear, ask me which one.

Verify the installation with:
node <installed-skill-dir>/scripts/golive.mjs version --json
Tell me if I need to reload skills or start a new session.
Stop after installation; don't connect accounts or deploy yet.
```

Die Installation enthält die Anweisungen, die Provider-Referenzen und die vorgebaute Runtime. Sie
verbindet keine Konten und deployt nichts. [Installation und Updates](docs/DISTRIBUTION.md) beschreibt
die nichtinteraktiven Agenten-Flags, die Prüfung der Runtime und den optionalen eigenen Installer.

### Installation aus npm

Derselbe Skill wird als `golive@0.1.0-alpha.4` auf npm veröffentlicht (dist-tags `alpha` und
`latest`) und lässt sich damit offline installieren, ohne Git und ohne Skills CLI:

```bash
# Codex
npx golive@alpha install --agent codex

# Claude Code
npx golive@alpha install --agent claude
```

Mit `--global` landet er in deinem Home-Verzeichnis (`~/.agents/skills/golive` oder
`~/.claude/skills/golive`) statt im aktuellen Projekt; auch `--agent claude-code`, die Schreibweise
des Skills-CLI-Kanals, wird akzeptiert. Der Installer kopiert den vollständigen Skill, den das Paket
mitbringt, verweigert ein bereits vorhandenes Ziel und verbindet nie Provider-Konten.

**Beide Kanäle liefern dasselbe Release.** Das npm-Paket veröffentlicht die Version aus diesem
Repository, inklusive der eigenständigen Installer-Helfer, sodass eine npm-Installation eine eigene
Kopie ist, die sich an Ort und Stelle aktualisiert. Der frühere Snapshot `0.1.0-alpha.0` hat keinen
Updater: Entferne diese Kopie und installiere neu, oder nutze den GitHub-Kanal, der seine
Installationen selbst verwaltet. Das npm-Paket stellt außerdem die Terminal-CLI bereit: die
golive-Befehle `npx golive@alpha help`, `version`, `update-check`, `credentials`, `detect`, `menu`,
`init`, `doctor`, `plan`, `teardown`, `apply`, `verify`, `status` und `handoff` (`apply` braucht die
freigegebene Plan-ID und eine ausdrückliche Bestätigung), dazu die Installer-Befehle `install`,
`install-status`, `update`, `rollback`, `update-policy` und `recover-lock` für die Kopien, die es
besitzt. Die genauen Grenzen dieses Kanals stehen in
[Installation und Updates](docs/DISTRIBUTION.md#alternative-installation-the-npm-package).

## GoLive benutzen

Öffne das Repository deiner App in deinem Coding-Agenten. Erscheint GoLive nach der Installation
nicht, lade die Skills neu oder starte eine neue Sitzung. Der Skill heißt **`golive`**. Für die oben
beschriebene eigenständige Installation tippst du eines davon **in den Chat deines Agenten**:

| Agent | Beispiel-Prompt |
| --- | --- |
| [Codex](https://learn.chatgpt.com/docs/build-skills#how-chatgpt-and-codex-use-skills) | `$golive Help me take this app live.` |
| [Claude Code](https://code.claude.com/docs/en/skills) | `/golive Help me take this app live.` |

Du kannst auch in normaler Sprache fragen:

```text
Use the golive skill to take this app live. Keep the providers it already uses.
Show me the destination accounts and plan before changing anything.
```

GoLive untersucht die App, fragt nach fehlenden Providern und legt dir die Zielkonten und den Plan zur
Freigabe vor, bevor beim Provider etwas geändert wird.

Das sind Chat-Prompts. `golive skill` ist kein Befehl. Eine Installation über `npx skills add` fügt
deinem Terminal keinen `golive`-Befehl hinzu; der Agent führt die mitgelieferte CLI aus dem
installierten Skill-Verzeichnis aus. Das [npm-Paket](README.md#install-from-npm) kann den Skill
ebenfalls offline installieren und stellt diese CLI als `npx golive@alpha <command>` bereit; seine
Terminal-Befehle führen einzelne Operationen aus, nicht den konversationellen Skill-Workflow.

## Wie ein Lauf aussieht

Ein beispielhafter Gesprächsverlauf für eine App, die bereits Supabase nutzt:

> **Du:** Nimm golive, um diese App live zu bringen. Nutze vorerst Testressourcen.
>
> **Agent:** Diese App nutzt Supabase. Wo möchtest du sie hosten?
>
> 1. **Vercel** — eingebauter Hosting-Workflow; live getestet mit Supabase.
> 2. **Netlify** — eingebauter Hosting-Workflow; die live getestete Kombination ist Netlify + Neon.
> 3. **Anderer** — nenn mir deinen Provider; ich versuche eine geführte Einrichtung über seine
>    offiziellen Tools und Docs.
>
> **Du:** Vercel.
>
> **Agent:** Supabase bleibt. Hat diese App schon ein Supabase-Projekt, oder sollen wir ein neues
> Testprojekt anlegen?
>
> **Du:** Leg ein neues an.
>
> **Agent:** Führe `vercel login` und `supabase login` in einem separaten Terminalfenster aus. Wenn du
> fertig bist, prüfe ich, welches Konto und welche Organisation verbunden sind.
>
> **Du:** Fertig.
>
> **Agent:** Hier ist der Plan: ein neues Test-Frontend-Projekt im ausgewählten Vercel-Team anlegen,
> seine Datenbank in der ausgewählten Supabase-Organisation anlegen, die nötigen Umgebungswerte
> übertragen und deployen. Die tatsächlichen Zielnamen und IDs, die Ressourcen-Einstellungen und die
> Kosteninformationen zeige ich zusammen mit dem Plan. Gib ihn frei, bevor ich ihn anwende.
>
> **Du:** Freigegeben.
>
> **Agent:** Das Deployment ist live. Hier sind die URL, der Verifikationsbericht und alles, was noch
> unverifiziert ist. Als Nächstes testen wir die Signup- und Datenflüsse der App selbst. Wenn du mit
> diesem Testprojekt fertig bist, plant `golive teardown` seine Entfernung zur Freigabe, bevor
> irgendetwas gelöscht wird.

GoLive behält die Provider bei, die deine App schon nutzt, und fragt nach den fehlenden Bausteinen.
Anmeldungen, Browser-Logins, Identitätsprüfungen und Käufe erledigst du selbst. Wird unter macOS ein
API-Key gebraucht, erklärt ein nativer Dialog mit verdeckter Eingabe, warum er fragt und wo der Key
gespeichert wird. Sein Wert geht direkt in die lokale Credentials-Datei, nie in den Chat oder in
Befehlsausgaben. Auf anderen Plattformen dient dein eigener Editor als Rückfallebene. Eine spätere
Änderung am Plan braucht eine weitere Freigabe; das Verbinden von Auth oder einer Domain kann einen
Nachlauf nach dem ersten Deployment erfordern.

**Du nutzt einen anderen Provider?** Der Skill hat einen allgemeinen geführten Ablauf: die offizielle
CLI des Providers prüfen, eine verfügbare offizielle MCP-Integration oder API nutzen und dich bei
Bedarf durch sein Dashboard führen. Ziel, Änderungen und Kosten zeigt der Agent trotzdem, bevor er um
Freigabe bittet, und danach prüft er, was er prüfen kann. Das ist **Best-Effort-Begleitung**, ohne
Garantie auf Abschluss und ohne dieselbe Verifikationsabdeckung wie ein eingebauter Adapter. Lässt
sich ein Schritt nicht abschließen oder nicht verifizieren, bekommst du den konkreten Blocker und die
nächste Aktion. Siehe [geführte Provider](docs/PROVIDERS.md#guided-providers).

## Was diese Alpha abdeckt

**Zwei Hosting-Optionen: Vercel und Netlify. Zwei Datenbank-Optionen: Supabase und Neon.**

| Live getesteter Pfad | Was erprobt wurde |
| --- | --- |
| **Vercel + Supabase** | Provisioning, Verdrahtung der Umgebungsvariablen, Deployment, authentifiziertes CRUD und Zugriffs-Isolation |
| **Netlify + Neon** | Provisioning, Verdrahtung der Umgebungsvariablen, Deployment, Postgres-Konnektivität, API-Checks mit zwei Sitzungen und CRUD im Browser |
| **Vercel + Porkbun (eigene Domain)** | Anhängen der Domain, ein freigegebener DNS-Record-Schreibvorgang unter `--confirm-dns`, Eigentumsnachweis und HTTPS-Auslieferung auf einer Wegwerf-Subdomain |
| **Vercel + GoDaddy (eigene Domain)** | Derselbe Ablauf auf einer zweiten Subdomain, inklusive der TXT-Challenge für den Eigentumsnachweis, die Vercel nach dem Anhängen verlangte |
| **Vercel + Resend (E-Mail)** | Einrichtung der Versanddomain, DNS-Records, Verifikation der Domain und ein echter Versand über den eigenen Umgebungs-Key der App (zugestellt; die frische Subdomain landete im Spam) |
| **Vercel + Stripe (Zahlungen im Testmodus)** | Keys im Testmodus und Webhook-Registrierung, die Ablehnung einer unsignierten Anfrage und eine echte Testkarten-Zahlung, die als signaturgeprüftes Event zugestellt wurde |
| **Supabase Auth (SMTP + Passwort-Wiederherstellung)** | Der Schreibvorgang für das Custom-SMTP, zurückgelesen zusammen mit dem erhöhten Auth-E-Mail-Rate-Limit, und die vollständige Wiederherstellungs-Rotation auf dem angelegten Testkonto — akzeptierte Anfrage, identische Antwort für eine unbekannte Adresse, verbrauchtes Token beim erneuten Einspielen abgelehnt, neues Passwort meldet sich an, das alte wird abgelehnt |

Das waren freigegebene Wegwerf-Läufe auf bestehenden Konten; die abgeschlossenen Testressourcen wurden
danach gelöscht, und die Wegwerf-Projekte und -Datensätze aus neueren Läufen werden unter derselben
Aufsicht aufgeräumt. Andere Kombinationen sind mock-abgedeckt, aber kein gleichwertiger Live-Beleg.
Die Wiederverwendung eines bestehenden Supabase-CLI-Logins hat separat eine schreibgeschützte
Verifikation bestanden; der vollständige Deployment-Test nutzte ein ausdrückliches Token. Die
Ersteinrichtung eines neuen Nutzers und jedes Anwendungs-Framework sind nicht validiert.

Die Lifecycle-Befehle haben eigene Belege: `golive teardown` wurde live an einem Wegwerf-Netlify-Projekt
erprobt (ohne `--confirm-destroy` blockiert, dann entfernt, die Site-Liste des Kontos blieb bis auf
dieses Projekt unverändert), und frühere Läufe entfernten die von golive geschriebenen GoDaddy- und
Porkbun-Records, widerriefen die Resend-Versandkeys, die es ausgestellt hatte, und entfernten den
Stripe-Endpunkt im Testmodus, den es registriert hatte. `golive status` lief schreibgeschützt gegen
ein Live-Projekt; `golive handoff --write` lief auf einem Wegwerf-Fixture, das nur aus dem Host
bestand: Beide Artefakte wurden geschrieben und geprüft (ein Herkunfts-Tag an jeder Aussagezeile, der
Eigentumsnachweis und das Teardown-Gate benannt, kein Wert in Credential-Form im Dokument, in seinem
JSON-Zwilling, im State oder in der Konfiguration), und das Projekt wurde danach über den
freigegebenen Teardown-Ablauf entfernt — der Stack bestand nur aus dem Host, die anderen
Provider-Zeilen des Dokuments bleiben daher mock-abgedeckt. Die Belege stehen unter
[beobachtete Validierung](docs/VALIDATION.md).

Für die Supabase-Auth-Konfiguration, den Signup-Ablauf von Supabase Auth, seine
Passwort-Wiederherstellung und die Konto-Isolation sowie für Cloudflare DNS gibt es außerdem
experimentelle Adapter. Die Supabase-Auth-Einstellungen — Signup, E-Mail-Bestätigung, Mindestlänge des
Passworts, der verwendete Mailer sowie Site-URL und Redirect-Allowlist — werden über einen
freigegebenen Plan automatisiert und zum Beleg zurückgelesen, und dieser Pfad hat einen
Wegwerf-Livelauf bestanden: Der Policy-Schreibvorgang hielt dem Zurücklesen stand (`password minimum
length: 6 → 12`), und `auth-policy` endete mit dem Hinweis auf den eingebauten Mailer als einzigem
Befund. Der Opt-in-Signup-Ablauf (`auth.e2e`) hat denselben Lauf bestanden: Ein freigegebener Schritt
legte ein echtes Testkonto an (`auth:test-user`, braucht `--confirm-live`), die Adresse konnte sich vor
der Bestätigung nicht anmelden (`email_not_confirmed`), und die Checks `auth-signup`/`auth-session`
belegten die Signup-E-Mail, die erzwungene Bestätigung, den bestätigten Login, das Sitzungstoken und
die Ablehnung anonymer Zugriffe. Zwei Grenzen bleiben: Die Bestätigung lief über die Auth-Admin-API
statt über den Klick auf die E-Mail im angelegten Konto, und die Zustellung ins Postfach wird per
Design von einem Menschen bestätigt — golive sieht das Postfach nie. Ein späterer freigegebener Lauf
auf einem Wegwerf-Fixture (eine deployte Vercel-Site, deren deklarierte Route ohne Sitzung mit 401
antwortet, plus eine Tabelle mit RLS-Schutz) hat beide App-seitigen Etappen erprobt: Ein anonymer GET
auf `auth.protectedPath` antwortete mit 401, und die angemeldete Probe las diese Tabelle als
authentifizierter Nutzer — damit ist der Bearer-Fix der Probe nicht mehr nur mock-abgedeckt. Was
dieser Beleg nicht zeigen kann: Die Tabellenzeile jenes Laufs ist eine Anzahl statt Tabellennamen, und
jede 401 zählte als geschützt — eine WAF- oder Wartungsseite hätte dasselbe gelesen; beides wurde
danach behoben (Issue #30: Die Probe benennt die gelesenen Tabellen, und ein verweigerter geschützter
Pfad wird gegen die öffentliche Root-URL abgesichert — mit Mock-Abdeckung und noch ohne erneuten
Livelauf). Die Passwort-Wiederherstellung ist **live validiert, auf demselben Provider**: Derselbe
Lauf vom 2026-09-24 enthielt `auth.smtp: resend` (der Custom-SMTP-Schreibvorgang und das erhöhte
Auth-E-Mail-Rate-Limit, beides zurückgelesen) und `auth.recovery: true`, bei dem ein freigegebener
Schritt (`auth:recovery`, braucht `--confirm-live`) das Passwort dieses aufgezeichneten Testkontos über
die eigenen Wiederherstellungsaufrufe des Providers rotierte — die E-Mail anfordern, den Link mit der
Admin-API erzeugen, ihn gegen eine Sitzung eintauschen, mit dieser Sitzung das neue Passwort setzen —,
und der Check `auth-recovery` bestand jede Etappe: Die Anfrage wurde akzeptiert, eine Adresse ohne
Konto bekam dieselbe Antwort (keine Konto-Enumeration), das verbrauchte Token wurde beim erneuten
Einspielen abgelehnt, mit dem neuen Passwort war eine Anmeldung möglich und mit dem ersetzten nicht.
Der Klick im Postfach
und etwaige Captchas bleiben beim Menschen (das sagt der Handoff `auth:recovery-email`), das
SMTP-Passwort ist write-only (der Provider antwortet mit einem Hash, der Rücklesevorgang belegt also
die Einstellungen, nicht eine Zustellung), und das Konto wurde über die Auth-Admin-API bestätigt statt
durch den Klick des Inhabers. Die Konto-Isolation ist ebenfalls auf demselben Provider implementiert:
`auth.isolation: true` mit `auth.identityPath` und `auth.isolationPath` fügt einen freigegebenen
Schritt hinzu (`auth:isolation`, braucht `--confirm-live`), der ein **zweites** echtes Testkonto anlegt
— die Adresse abgeleitet aus `auth.testEmail`, das Passwort wieder nur im Speicher jenes Laufs — und
es über die Admin-API des Providers bestätigt (kein zweiter Klick im Postfach: In diesem Ablauf geht
es um die Daten der App, nicht um die Zustellung). Der Check `auth-isolation` meldet sich dann als
beide Konten an und liest die beiden deklarierten Routen der App auf der Produktions-URL: Beide müssen
einen anonymen Aufrufer abweisen (eine 200 ist ein kritischer Befund), die Identitätsroute jedes
Kontos muss mit der eigenen User-ID antworten und nie mit der des anderen, und die Zeilenroute darf
nur die eigenen Zeilen des Aufrufers zurückgeben — geprüft mit je einer eindeutigen Markerzeile pro
Konto, **über diese Route** mit der Sitzung des Kontos geschrieben und zurückgelesen, sodass der
Marker eines anderen Kontos in der Antwort ein kontoübergreifender Lesezugriff ist und kritisch
fehlschlägt. Sind die Routen nicht deklariert, übergibt der nicht blockierende Handoff
`auth:isolation-routes` die Aufgabe am App-Code; eine 404 oder eine verweigerte Sitzung wird mit
benannter Aufgabe übersprungen — nie als bestanden. Die Konto-Isolation ist **implementiert und
mock-abgedeckt, aber noch nicht live validiert** — ihr Livelauf kommt separat. Die Ausgabe des
Wiederherstellungslaufs selbst enthielt zwei Defekte, beide hier mit Mock-Regressionen behoben:
`teardown` meldete die *übernommene* Versanddomain des Inhabers als von golive angelegt (eine leere
Liste von Erstellungsmarkern machte `[].every()` wahr, also las sich jede aufgezeichnete Domain als
golives), und der Handoff `auth:recovery-email` zeigte den Skip eines eigenständigen `verify` als
Beleg, während der State diesen Schritt als erledigt führte. Sein dritter Befund — Resend meldete die
Domain weiterhin als verifiziert, obwohl die von ihm aufgelisteten Records im autoritativen
Nameserver der Zone fehlten — ist durch
[#52](https://github.com/mikehasa/golive-skill/issues/52) behoben: `email-verified` löst jetzt die
Records auf, die der Provider selbst für die Domain auflistet, bevor der Check besteht (eine
verifizierte Domain, deren Records verschwunden sind, schlägt fehl, ein von golive innerhalb des
Propagationsfensters geschriebener Record erzeugt nur eine Warnung, und ein Provider, der sie nicht
auflisten kann, wird übersprungen statt als bestanden gewertet), und der E-Mail-Plan behält den Schritt
oder Handoff `email:dns` für Records, die nicht auflösen, sodass ein veraltetes Flag sie nicht länger
verbergen kann. Mock-abgedeckt; nicht erneut live erprobt. Die oben aufgeführten DNS-, E-Mail- und
Testmodus-Zahlungspfade sind die getesteten, wobei die Läufe mit eigenen Domains Record-Schreibvorgänge
über Porkbun und GoDaddy nutzten; **Cloudflare DNS ist speziell noch kein validierter Alpha-Pfad**, und
andere Auth-Provider bleiben geführt. Siehe [Provider-Umfang](docs/PROVIDERS.md) und
[beobachtete Validierung](docs/VALIDATION.md).

## Die vollständige Go-live-Checkliste und Roadmap

Eine funktionierende URL ist der Anfang. Je nach App kann „live gehen“ all das bedeuten: **GoLive soll
herausfinden, welche Punkte zutreffen, dir helfen, sie abzuschließen, und Belege für das Ergebnis
zeigen.** Eine statische Site soll keine Datenbank einrichten müssen; ein bezahltes SaaS soll nicht
bei einer deployten Startseite stehen bleiben.

Das hier ist unsere Produkt-Roadmap in Form einer Launch-Checkliste. Häkchen und Durchstreichungen
markieren **konkrete live getestete Meilensteine**, nicht eine abgeschlossene Kategorie und keine
vollständige Checkliste für deine App.

**✅ Live getestet** · **🚧 In Arbeit / experimentell** (Code existiert; vollständiger Ablauf steht
aus) · **🗺️ Geplant**

### Die App ausliefern

- [x] ✅ **Frontend-Hosting:** ~~Deployment auf Vercel und Netlify nachweisen.~~ Das vorgesehene
  Projekt auf den zwei getesteten Pfaden bauen, deployen und verifizieren.
- [x] ✅ **Datenbank:** ~~Provisioning und Verbindung mit Supabase und Neon nachweisen.~~ Die
  getesteten Pfade umfassen die Verdrahtung der Umgebungsvariablen und CRUD-Checks der Anwendung.
- [x] ✅ **Verdrahtung der Umgebung:** ~~Hosting- und Datenbank-Credentials auf beiden getesteten
  Pfaden verbinden.~~ Weitergehende Secret-Rotation und die Verwaltung des Lebenszyklus von
  Umgebungen bleiben geplant.
- [ ] 🗺️ **Backend / Server:** dedizierte API-Dienste, Container, persistente Server,
  Runtime-Konfiguration und Health-Checks. App-Routen deployen bereits über die unterstützten Hosts.
- [ ] 🗺️ **Schema und Daten:** geprüfte Migrationen, sicherer Rollout, Trennung der Umgebungen und
  Datenchecks der App. Diese wurden in Livetests separat beaufsichtigt; ein wiederverwendbarer
  Workflow ist weiterhin geplant.
- [ ] 🗺️ **Datei- und Objektspeicher:** Buckets, Uploads, Zugriffsregeln, signierte URLs und
  Lifecycle-Policies.

### Ein vollständiges Produkt daraus machen

- [ ] 🚧 **Authentifizierung:** Signup, Login, Sitzungen, Passwort-Wiederherstellung und
  Konto-Isolation. Die Supabase-Auth-Policy (Signup, E-Mail-Bestätigung, Mindestlänge des Passworts,
  Mailer) und die Allowlist für Site-URL und Redirects werden über einen freigegebenen Plan
  geschrieben, zum Beleg zurückgelesen und durch die Checks `auth-policy`/`auth-redirects`
  verifiziert — erprobt in einem freigegebenen Wegwerf-Lauf, in dem der Policy-Schreibvorgang mit
  einem Minimum von zwölf Zeichen hielt. Der Opt-in-Ablauf (`auth.e2e: true`) hat denselben Lauf
  bestanden: Der Schritt `auth:test-user` legte ein echtes Testkonto an, diese Adresse konnte sich vor
  der Bestätigung nicht anmelden, und die Checks `auth-signup`/`auth-session` belegten die
  Signup-E-Mail, die erzwungene Bestätigung, den bestätigten Login und das Sitzungstoken — **live
  validiert für Supabase über Wegwerf-Projekte hinweg, wobei die Bestätigung über die Auth-Admin-API
  kam statt über den Klick auf die E-Mail des angelegten Kontos, die Zustellung ins Postfach
  menschlich bestätigt blieb und ein späterer Lauf einen deklarierten geschützten Pfad (eine anonyme
  401) sowie einen angemeldeten Lesezugriff auf eine RLS-geschützte Tabelle nachwies, gemeldet als
  Anzahl statt als Tabellenname**. Die Passwort-Wiederherstellung ist **live validiert, auf demselben
  Provider** (`auth.recovery: true` fügt den Schritt `auth:recovery` und den Check `auth-recovery`
  hinzu, die auf einem Wegwerf-Projekt keine Konto-Enumeration, ein Einmal-Token und das ersetzte
  Passwort nachwiesen; die Bestätigung kam über die Auth-Admin-API, der Klick im Postfach bleibt
  menschlich bestätigt, und zwei Ausgabedefekte, die jener Lauf fand — eine falsche
  Eigentumsbehauptung „von golive angelegt“ und ein Handoff-Belegtext, der dem aufgezeichneten Schritt
  widersprach — sind mit Mock-Regressionen behoben). Die Konto-Isolation — die andere Hälfte und
  genau die, die frühere Läufe nicht erproben konnten — ist genauso implementiert und mock-abgedeckt:
  `auth.isolation: true` mit `auth.identityPath` und `auth.isolationPath` fügt den Schritt
  `auth:isolation` hinzu (ein zweites echtes Testkonto, bestätigt über die Admin-API des Providers und
  mit ID und Adresse aufgezeichnet) sowie den Check `auth-isolation`, der sich als beide Konten
  anmeldet und auf den eigenen Routen der App nachweist, dass keines die Identität oder die Zeilen des
  anderen lesen kann (ein kontoübergreifender Lesezugriff schlägt kritisch fehl; eine nicht
  deklarierte oder 404-Route wird mit der Aufgabe am App-Code übersprungen). Ihr Livelauf kommt
  ebenfalls separat. Andere Auth-Provider bleiben geführt.
- [ ] 🗺️ **OAuth / Social Login / SSO:** Client-Registrierung, Consent-Screens, Scopes, Callback-URLs
  und Reviews beim Provider. Die aktuelle Einrichtung von Auth-Providern ist geführt.
- [x] ✅ **Zahlungen und Abos:** ~~Checkout im Testmodus und Webhook-Annahme mit Stripe nachweisen.~~
  Eine echte Testkarten-Zahlung lieferte ein signaturgeprüftes `checkout.session.completed`-Event.
  Bereitschaft für den Live-Modus, Entitlements, Rückerstattungen und Abo-Events brauchen noch
  Validierung.
- [x] ✅ **Transaktions-E-Mail:** ~~Einrichtung der Versanddomain, Verifikation und echte Zustellung
  mit Resend nachweisen.~~ Ein Versand über den eigenen Umgebungs-Key der App wurde zugestellt (auf
  einer frischen Subdomain in den Spam, noch kein DMARC). Mit `auth.smtp: resend` schreibt der Schritt
  `auth:smtp` außerdem das Custom-SMTP des Auth-Projekts — Host/Port/User von Resend, den Absender,
  den die App bereits nutzt, und ein SMTP-Passwort aus einem von golive ausgestellten Versandkey (dem
  Key des E-Mail-Ablaufs oder einem, den es nur für SMTP ausstellt) — und hebt im selben Schreibvorgang
  das Auth-E-Mail-Rate-Limit des Projekts (`rate_limit_email_sent`) auf 30 pro Stunde (oder
  `auth.emailRateLimitPerHour`) an, weil der Provider dieses Limit zusammen mit Custom-SMTP führt.
  `auth-policy` meldet dann `custom SMTP via Resend` statt vor dem eingebauten Mailer zu warnen. Das
  Passwort ist write-only (der Provider antwortet mit einem Hash), der Rücklesevorgang bestätigt also
  die Einstellungen, und eine echte Auth-E-Mail ist der einzige vollständige Beweis. **Live validiert
  auf einem Wegwerf-Projekt (2026-09-24):** Derselbe Lauf schrieb das Custom-SMTP und las es zurück
  (`smtp.resend.com`, Port 465, User `resend`, Absender `auth@mail.trytofu.xyz`) zusammen mit
  `auth email rate limit: 2 → 30 per hour`, stellte den SMTP-Key selbst aus und widerrief ihn beim
  Teardown, und `auth-policy` las danach `custom SMTP via Resend` mit 30 Auth-E-Mails pro Stunde — nur
  Einstellungen und Rate-Limit, denn das Passwort selbst lässt sich nie zurücklesen.
  Bounce-Behandlung, reichhaltigere Nachrichteninhalte und die tatsächliche Zustellung ins Postfach
  (per Design menschlich bestätigt und bei der Domain jenes Laufs zweifelhaft — siehe
  [Issue #52](https://github.com/mikehasa/golive-skill/issues/52)) brauchen noch Validierung.
- [x] ✅ **Domains / DNS / HTTPS:** ~~Anhängen der Domain, DNS-Verdrahtung und HTTPS-Auslieferung bei
  Host+DNS-Paaren nachweisen.~~ Getestet: Anhängen bei Vercel mit Record-Schreibvorgängen bei Porkbun
  und GoDaddy unter `--confirm-dns`, Eigentumsnachweis und HTTPS 200 auf Wegwerf-Subdomains. Der
  Cloudflare-DNS-Adapter, Redirects und weitere Host-Paarungen brauchen noch Live-Validierung.
- [ ] 🗺️ **SMS und Push-Benachrichtigungen:** Registrierung des Absenders, Credentials,
  Berechtigungen und Zustellungschecks.
- [ ] 🗺️ **Drittanbieter- und KI-Dienste:** API-Zugang, Scopes, Callbacks, Quotas und
  Funktionstests. Fehlende Umgebungsvariablen werden heute erkannt; dienstspezifische Workflows sind
  geplant.
- [ ] 🗺️ **Hintergrundarbeit:** Cron-Zeitpläne, Queues, Worker, Wiederholungsversuche und die
  Wiederherstellung fehlgeschlagener Jobs.
- [ ] 🗺️ **Cache, Suche und Realtime:** Caches, Such- und Vektorindizes sowie Realtime-Dienste, wo
  sie gebraucht werden.

### Mit Zuversicht launchen und dann am Laufen halten

- [ ] 🗺️ **Sicherheit und Missbrauchsschutz:** Zugriffsrichtlinien, offenliegende Credentials,
  Security-Header, Rate-Limits und Bot-Schutz. Eingegrenzte RLS-/Advisor- und
  Credential-Muster-Checks gibt es heute schon.
- [ ] 🗺️ **Monitoring und Alarme:** Fehler-Tracking, Logs, Uptime und umsetzbare Alarme.
  Provider-Vorschläge sind heute geführt; eine verifizierte Einrichtung ist geplant. Drift-Prüfungen
  auf Abruf gibt es (`golive status`, unten) — kontinuierliches Monitoring und Alerting nicht.
- [ ] 🗺️ **Produkt-Analytics:** Event-Validierung sowie Consent- und Dateneinstellungen, über die
  heutigen geführten Provider-Vorschläge hinaus.
- [ ] 🚧 **CI/CD und sichere Releases:** Previews, Release-Checks, Promotion, Rollback und
  Drift-Erkennung, aufbauend auf den heutigen freigegebenen CLI-Deployments. **Deployment-Identität —
  implementiert, nicht live validiert:** Jedes erfolgreiche Deployment zeichnet die Identität auf, die
  der Provider selbst für dieses Deployment meldet (`deployed:<target>:id` =
  `<provider>|<deployment id>|<url>|<time>` in `.golive/state.json`, mock-abgedeckt; ein Provider, der
  keine Identität meldet, zeichnet keine auf), sodass eine spätere Funktion genau ein Deployment
  benennen kann. **Opt-in-Preview-Deployment und Release-Check — implementiert, nicht live validiert:**
  Mit `release.preview: true` in `golive.yaml` (und `preview` in `targets`) fügt `plan`
  `preview:deploy` hinzu — ein Create, das den aktuellen Arbeitsstand in das Preview-Ziel des Hosts
  deployt, Provider, Projekt, Env-Ziel und das Quellprojekt benennt, das sich die Preview mit der
  Produktion teilt, `--confirm-live` braucht, wenn ein Wert im Live-Modus einen Preview-Env-Namen
  füllt, und die eigene Identität des Providers als `deployed:preview:id` aufzeichnet — sowie
  `release:check`, der nichts schreibt, `preview:deploy` als Voraussetzung deklariert und den Plan
  fehlschlagen lässt, wenn das Lesen dieses Deployments beim Provider oder ein Credential-Scan seines
  Bundles fehlschlägt. In einem Plan, der einen Release-Kandidaten baut, ist dieser Check der letzte
  Schritt; was er absichert, ist also die Promotion (deren eigener Plan den Check vor
  Produktionsänderungen erneut ausführt), nicht das Produktions-Deployment, das derselbe Plan bereits
  davor enthält. **Promotion und Rollback — implementiert, nicht
  live validiert:** Mit `release.promote: true` (zusätzlich zum Preview-Opt-in) fragt ein Plan ein
  Release per Promotion an, und mit `release.rollback: true` bittet er darum, die Produktion auf ein
  früheres Deployment umzulenken, das golive selbst angelegt und aufgezeichnet hat.
  `promote:production` benennt die genaue Deployment-ID, die es zur Produktion machen würde — der
  Provider meldet die ID eines Deployments erst, wenn das Deployment existiert, also sind der Bau des
  Kandidaten und seine Promotion zwei Pläne, und der Plan, den du freigibst, benennt, um welchen der
  beiden es geht —, wird durch `release:check` abgesichert, der dieses Deployment im selben Plan erneut liest,
  und braucht **kein zusätzliches Bestätigungs-Flag**: die Plan-ID, das benannte Deployment und das
  frische Gate sind die Freigabe. Beide Schritte lesen das Ziel-Deployment und das, was die Produktion
  ausliefert, vor dem Schreiben erneut und belegen danach, was die Produktion ausliefert; beide behalten
  den Stopp über Release-Grenzen hinweg (keiner ist `replayable`, keiner ist eine Löschung), und keiner
  ist automatisch — kein fehlgeschlagener Check löst einen Rollback aus, und ein Deployment, das über
  ein Dashboard, einen Git-Push oder einen Pull Request entstanden ist, ist nie Ziel einer Promotion
  oder eines Rollbacks (es ist ein Handoff und wird als solcher benannt). Was jeder Host unterstützt,
  unterscheidet sich, und golive verweigert, statt zu raten: Netlify liest sein veröffentlichtes
  Deployment erneut und kann ein früheres wiederherstellen, beide Schritte funktionieren dort also;
  Vercel bietet kein Lesen dessen, was die Produktion ausliefert, und keinen Promote- oder
  Rollback-Aufruf, den golive erprobt hätte, auf Vercel wird also nichts promotet oder zurückgerollt
  und eine Warnung sagt, warum. `production-release` belegt, was die Produktion ausliefert, benennt,
  was sie zuvor ausgeliefert hat, und meldet ein Deployment, das golive nie aufgezeichnet hat, als
  Handoff. Diese Schritt-IDs hinzuzufügen ändert die ID eines Plans, eine nicht angewendete Freigabe
  muss also neu geplant werden. Die Preview-Checks (und damit die Promotion) werden auf einem Host
  übersprungen, der kein Lesen pro Deployment bietet (Vercel), und melden das, statt zu raten.
  Drift-Erkennung gibt es als schreibgeschützten Befehl `golive status` weiter unten (er lief
  schreibgeschützt in der Auth-Validierung und hatte nichts zu tun, sobald jener Ablauf bestanden war,
  aber den DNS-, Umgebungs-, Webhook- und Deployment-Baselines, die er vergleicht, fehlen weiterhin
  Live-Belege), und Preview-Deployments gehören noch nicht zu den Subjekten, die er vergleicht.
- [ ] 🗺️ **Backups und Wiederherstellung:** Aufbewahrung, Restore-Übungen, Schritte für Vorfälle und
  freigegebenes Aufräumen. Ein freigegebenes `teardown` entfernt, was golive angelegt hat; Backups und
  jeder Restore bleiben manuelle, beaufsichtigte Arbeit.
- [x] ✅ **Deinstallation / Teardown:** ~~ein freigegebenes Inventar der von golive angelegten
  Ressourcen und ihre Entfernung.~~ `golive teardown` plant die Entfernung, löscht nur, was golive
  nachweislich angelegt hat (Eigentumsnachweise und `--confirm-destroy`), und liest nach dem Löschen
  die golive-eigene Record-Liste der DNS-Zone und das Host-Projekt selbst erneut. Nichts, was es nicht
  entfernen kann, wird still fallengelassen: Ein Rest — eine Zone ohne Leserechte, ein nicht
  entfernbares Host-Projekt, ein Provider, bei dem keine Anmeldung besteht — wird zu einem Handoff,
  der benennt, was bleibt und was genau zu tun ist, und Supabase-/Neon-Projekte sowie die
  Resend-Versanddomain bleiben manuelle Handoffs
  ([#9](https://github.com/mikehasa/golive-skill/issues/9)). Eine Entfernung vergisst die Baseline,
  die golive für diese Ressource aufgezeichnet hat, damit `golive status` golives eigenen Teardown
  nicht als Drift meldet, und ein von golive widerrufener Versandkey wird als Warnung gemeldet statt
  als bestanden, weil der Provider kein Lesen anbietet, das ihn bestätigen könnte.
- [ ] 🗺️ **Kosten und Quotas:** Auswahl des Plans, Budgets, Alarme und Kapazitätsprüfungen.
  Eingegrenzte Guards für den Free-Plan gibt es heute; laufendes Kostenmanagement ist geplant.
- [ ] 🗺️ **Launch-Essentials:** Metadaten, Share-Previews, Indexierung, Barrierefreiheit,
  Support-Links und vom Inhaber geprüfte Policy-Seiten.
- [ ] 🚧 **Eigentum und Übergabe:** Konten, Ressourcen, Zugriff, Verantwortung für Verlängerungen und
  Wartungsanleitungen. `golive handoff --write` hält den Login-Weg, die Eigentumsnachweise,
  wiederkehrende Jobs und die Entfernungs-Gates in `GOLIVE_HANDOVER.md` fest und taggt jede Zeile als
  verified, recorded, not verifiable oder unknown, und `golive status` liest diese Subjekte auf Abruf
  erneut: Er vergleicht die von golive aufgezeichneten Baselines mit den Providern, wie sie jetzt sind,
  und benennt, was er nicht lesen konnte. Das Neusetzen von Drift-Baselines bleibt manuell und
  freigabepflichtig — der Befehl ist implementiert und lief in der Auth-Validierung schreibgeschützt,
  eine Live-Validierung jedes Drift-Subjekts steht aber noch aus.

Manche Schritte brauchen immer einen Menschen: Bedingungen akzeptieren, Identitätsprüfung, Käufe,
Abrechnungsentscheidungen und Reviews, die ein Provider verlangt. „Geführt“ soll trotzdem eine klare
nächste Aktion bedeuten, die richtige Seite, die richtigen Berechtigungen, einen Check danach und die
Rückkehr in denselben Workflow. Wenn die App selbst Codeänderungen braucht, soll GoLive dem
Coding-Agenten eine konkrete Aufgabe geben und das Ergebnis erneut prüfen. Es soll dich nicht dazu
bringen, ein Dutzend zusammenhangloser Einrichtungsgespräche zu koordinieren.

**Als Nächstes:** die verbleibenden Launch-Abläufe abschließen und live testen — der Livelauf für die
Konto-Isolation (auf Supabase implementiert und mock-abgedeckt, noch nicht gegen ein echtes Projekt
erprobt), Zahlungsflüsse im Live-Modus und der Cloudflare-DNS-Adapter —, danach App-Architekturen und
den laufenden Betrieb ausbauen.

Das sind Richtungen, keine Release-Termine. Eine Fähigkeit sollte erst dann aus dem Experimentellen
herauswachsen, wenn ihr Konto-Setup, ihre Verbindung, ihre Verifikation und ihre Wiederherstellung
erprobt sind. Beiträge zu jedem Teil dieser Checkliste sind willkommen, besonders Belege dafür, wo ein
echter Launch stecken bleibt.

<details>
<summary>Produktions-Checklisten, die diese Roadmap prägen</summary>

Der Umfang orientiert sich an [Vercels Launch-Checkliste](https://vercel.com/docs/production-checklist),
[Supabases Production-Checkliste](https://supabase.com/docs/guides/deployment/going-into-prod),
[Stripes Go-live-Checkliste](https://docs.stripe.com/get-started/checklist/go-live),
[Googles OAuth-Leitfaden für die Produktion](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance)
und der [Next.js-Produktionsanleitung](https://nextjs.org/docs/pages/guides/production-checklist).
Sie prägen die Ziele oben; sie sind keine GoLive-Funktionen und keine pauschalen Anforderungen für
jede App.

</details>

## Verifikation, die du selbst nachprüfen kannst

Der Bericht hält die Ergebnisse **pass, fail, warning und skipped** fest, dazu die verbleibenden
menschlichen Schritte. Zu den Checks gehören Konto-Zugriff, Namen von Umgebungsvariablen, vom Provider
bestätigte Deployment-URLs, Muster für Secrets in öffentlichem JavaScript, Datenbankzugriff,
unterstützte Auth-, Webhook- und DNS-Einstellungen und — wo der Host antworten kann — das Deployment,
von dem der Provider sagt, dass die Produktion es ausliefert.

Ein fertiges Deployment ist kein Beweis, dass die App funktioniert. Ein Name einer Umgebungsvariablen
kann mit falschem Wert existieren. Eine verifizierte E-Mail-Domain beweist keine Zustellung ins
Postfach. Signierte Zahlungs-Events, Signup und die Geschäftsflüsse der App brauchen Funktionstests.
**Skipped ist nicht bestanden.**

Deine App bekommt `golive.yaml`, `.golive/state.json`, `.golive/report.json` und `GOLIVE_REPORT.md`.
Der State bewahrt Ressourcen-IDs und Schrittbelege für die Wiederherstellung auf; er ist kein
Credential-Speicher. `golive teardown` entfernt, was golive nach eigener Freigabe und
`--confirm-destroy` angelegt hat; für diese Ressourcen gibt es keinen providerübergreifenden Rollback,
kein Restore und keinen allgemeinen Abgleichsbefehl — `release:rollback` (Opt-in) lenkt nur die
Produktion auf ein früheres, von golive selbst aufgezeichnetes Deployment um und berührt keine Daten-,
DNS-, Zahlungs- oder E-Mail-Ressource.

`golive handoff --write` ergänzt das Eigentumsdokument: `GOLIVE_HANDOVER.md` im Repo-Wurzelverzeichnis
und seine JSON-Quelle in `.golive/handover.json`. Es benennt die Konten und den Login-Weg, jede von
golive angelegte Ressource und den Nachweis, dass sie golive gehört, was weiterhin manuell ist, was
sich wiederholt, wie die Entfernung läuft und welche Befehle welches Subjekt erneut prüfen. Jede Zeile
sagt, ob sie in jenem Lauf verifiziert wurde, früher aufgezeichnet, von golive nicht verifizierbar
oder unbekannt; golive hat keine Abrechnungsdaten gelesen, es wird also keine Kostenangabe gemacht. Die
Dateien enthalten keine Secret-Werte, aber secret-freie Metadaten können private Ressourcen trotzdem
identifizieren — prüfe sie, bevor du sie teilst. `--write` überschreibt niemals eine Datei, die golive
nicht erzeugt hat, außer `--force` wird übergeben.

`golive status` stellt die Anschlussfrage: Hat sich hinter golives Rücken etwas geändert, seit es
festgehalten hat, was es getan hat? Er vergleicht aufgezeichnete Baselines — die von golive
geschriebenen DNS-Records, die **Namen** der übergebenen Umgebungsvariablen, den registrierten
Webhook-Endpunkt, das Anhängen der Domain, das Datenbankprojekt und seine Verbindungsselektoren, die
Versanddomain, das Zahlungskonto hinter den Keys der App, das Host-Projekt — mit jetzt gelesenen Werten
und beschriftet beide Seiten: `expected (recorded by golive <time>)` gegen `observed (read now)`. Jeder
Punkt sagt, wer handeln kann: einen Check erneut ausführen, eine freigegebene Änderung neu planen und
anwenden, oder eine Entscheidung, die nur ein Mensch treffen kann. Der Befehl ist schreibgeschützt:
keine Berichtsdatei, kein Schreibvorgang beim Provider, keine State-Änderung, und er endet mit `2`,
wenn etwas zu tun ist. Ein Provider, den er nicht lesen kann, wird als nicht verifizierbar gemeldet —
nie als sauber und nie als Fehler —, und er setzt niemals von selbst eine Baseline neu. Drift ist
bewusst kein Gate: `plan`, `apply` und `verify` ziehen ihn nie heran. `status` ist **implementiert**
und lief während der Supabase-Auth-Validierung schreibgeschützt (ein fehlgeschlagener Schritt erschien
als handlungsrelevant, danach eine leere Liste, sobald er abgeschlossen war), eine Live-Validierung der
verbleibenden Drift-Subjekte steht aber noch aus.

## Credentials und Kontrolle

- **Erst freigeben, dann Konten ändern.** Pläne benennen die Ziele und die beabsichtigten
  Schreibvorgänge, und `apply` verweigert ohne die ID des freigegebenen Plans und ohne `--yes`. Wird
  das installierte Release gewechselt, verlieren alte Freigaben ihre Gültigkeit. DNS-, Live-Zahlungs-
  und Löschschritte haben zusätzliche Gates (`--confirm-dns`, `--confirm-live`, `--confirm-destroy`),
  und das erste Produktions-Deployment eines Projekts braucht ebenfalls `--confirm-live`, weil früher
  die Freigabe eines Plans allein ausreichte, um zum ersten Mal in die Produktion zu schreiben.
  [Vertrauen, Zugriff und Kontrolle](docs/TRUST.md#what-golive-may-write-and-what-comes-first) geht
  jedes Gate durch.
- **Secrets gehören nicht in den Chat.** Unterstützte Vendor-Logins werden wiederverwendet. Unter
  macOS kann ein nativer Dialog mit verdeckter Eingabe einen benötigten API-Key speichern; dein eigener
  Editor ist die Rückfallebene. Keys liegen in `~/.config/golive/credentials`, einer lokalen
  Klartextdatei mit Modus 0600 außerhalb deines App-Repos — kein OS-Keychain, alles, was unter deinem
  Nutzer läuft, kann sie also lesen. Der Ausführungscode hält Werte aus argv, Plänen, State, Berichten
  und Befehlsausgaben heraus und speichert stattdessen Fingerabdrücke. `golive credentials --remove
  NAME --yes` löscht einen gespeicherten Eintrag, unwiderruflich; was den Zugriff wirklich beendet, ist
  das Widerrufen des Tokens beim Provider. Mac-Login-Passwörter bleiben bei den
  Authentifizierungsdialogen von macOS bzw. des Vendors; GoLive fordert dich nie auf, eines in seinem
  Key-Dialog einzugeben. Die vollständige Grenze steht in
  [Vertrauen, Zugriff und Kontrolle](docs/TRUST.md#the-credential-boundary).
- **Updates haben einen Verantwortlichen.** Die Skills CLI verwaltet ihre Installationen. Der
  optionale eigene Installer unterstützt Updates des gesamten Bundles und einen lokalen Rollback;
  automatischer Austausch ist standardmäßig aus. Aktualisiere zwischen Deployment-Läufen, nie zwischen
  einem Plan und seinem Apply. Cloud-Ressourcen sind von einem Rollback nicht betroffen.
- **Deine Konten bleiben deine.** GoLive kauft keine Dienste und legt keine Abrechnungskonten an. Dein
  Coding-Agent, die Provider und der Installer haben ihre eigenen Datenpraktiken.

## Mitwirken

🤝 **Wir sind früh dran und freuen uns über deine Hilfe bei der Gestaltung von GoLive.** Bug-Reports,
Funktionsideen, Doku-Korrekturen und Pull Requests sind alle willkommen. Für einen Beitrag musst du
keinen Adapter bauen: Eine unklare Login-Anweisung oder ein echter Launch, der stecken geblieben ist,
ist ebenfalls nützliches Feedback.

Öffne ein Issue, um ein Problem zu melden oder eine Idee zu diskutieren, oder schick einen fokussierten
PR. Für einen größeren Provider- oder Workflow-Zusatz starte am besten ein Issue, damit wir den Umfang
gemeinsam abstimmen können. Packe niemals Secrets oder rohe Auth-Antworten in einen Bericht.

Siehe **[CONTRIBUTING.md](CONTRIBUTING.md)** für die lokale Einrichtung, Tests und deinen ersten
Beitrag. Die [Architektur](docs/ARCHITECTURE.md), [Vertrauen, Zugriff und Kontrolle](docs/TRUST.md),
[Wiederherstellung](docs/RECOVERY.md), der [Provider-Umfang](docs/PROVIDERS.md) und das
[Validierungsprotokoll](docs/VALIDATION.md) erklären, was existiert und wo Hilfe gebraucht wird.

[MIT-lizenziert](LICENSE). Die Hinweise zu eingebundenen Drittanbietern stehen in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
