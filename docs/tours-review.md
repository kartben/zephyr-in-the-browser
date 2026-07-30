# Guided tours: review and action plan

Zephyr in the Browser · `/home/user/zephyr-in-the-browser` · review date 2026-07-30

Inputs: seven persona reviews of the live deployed build, a structured 24-tour catalog proposal,
four candidate prose styles, and a product/engineering audit against the implementation. Every
claim below is traceable to a file and line, a rendered card, or a named persona.

---

## 1. Executive summary

**What is true today.** The architecture is right. A tour is Markdown that ships with the page,
the guest is stock upstream Zephyr byte-for-byte (`docs/tours.md`: "Nothing at all, not 'nothing
that matters'"), and anchors resolve from the build's own `.symtab` and `.debug_line`. That means a
tour can break inside kernel code the sample does not own (`at: z_impl_k_sleep` from a blinky tour),
and it means the marginal cost of tour number three is an afternoon of prose against one of the 46
samples already packaged on `qemu_cortex_a53`. Nothing else in the Zephyr ecosystem can put a claim
and its evidence on the same screen. Philosophers card 4/5, six `fork_objs` rows with `[4]` and `[5]`
owned by `thread@40018e80`, is the proof, and all seven personas named it independently.

**The three things that matter most.**

1. **The feature has no lifecycle.** It auto-starts without asking (`qemu.ts:310` forces `-S` for any
   sample with a tour), never ends (blinky's step 5 is `repeat: yes` + `stop: no` and re-fires at hit
   20, 30, 40 forever), has no replay, no address (`App.tsx:51` reads only `board`, `backend`, `app`),
   and no index (4 of 90 gallery rows carry a badge, two of them the same sample). `TourState.finished`
   is computed at `store.ts:714` and no component reads it. Six of seven personas hit these four walls
   independently. They are all small fixes.
2. **Two capabilities are missing that no amount of prose can substitute for.** A devicetree directive
   (blinky card 1 is entirely about devicetree and renders C, while the viewer two clicks away renders
   `aliases { led0 = &led0; }` verbatim) and a stop condition over target *state* instead of a hit
   counter (`when: hits == 6` on philosophers 4/5, with prose saying "look for blocked philosophers"
   on a run where none were blocked). The second is a correctness problem, not a polish problem: the
   engine currently permits a card to assert a state it has not checked.
3. **Nothing detects rot, and the rot is silent by design.** `west.yml:24` is `revision: main`.
   `.github/workflows/build-images.yml` contains zero occurrences of the string `tour`.
   `guided.test.ts:11-21` says in its own header that it cannot resolve anchors. The dangerous case is
   not an anchor that fails, it is a pattern anchor that fails while its mandated numeric fallback
   resolves, because then the card marks the wrong line with full confidence. Going from 2 tours to 20
   multiplies that exposure tenfold with zero detection.

**Recommendation, in one sentence.** Keep tours, throw away the sample-keyed index, and spend the next
two months in this order: close the lifecycle and gate the image build on anchor resolution (Phase 0,
one week), then ship the ten pure-Markdown tours that need no engine work while `dts:` and predicate
stops are built, then rewrite blinky and philosophers last, because they are the two tours that most
need capabilities that do not exist yet.

---

## 2. What the personas found

### 2.1 Maintainer (upstream subsystem maintainer, ~30 PRs/week)

**Verdict:** engaged, and will not link it from `docs.zephyrproject.org` in its current state. Not
because the content is bad, but because "a docs link is a promise about a URL that stays true, and
right now nothing in this repository can tell you whether it still is."

**Sharpest criticism:** the rot gate. `west.yml:24` tracks `main`, the image workflow never validates
an anchor, and `docs/tours.md` sells silent degradation as a feature ("An anchor that does not resolve
costs one step, not the tour"). The mandated `|` fallback protects against *missing* sources and
actively manufactures a wrong answer against *edited* sources: pattern misses, `main.c:32` resolves,
card puts a `▸` on whatever is now line 32. "Silently wrong is strictly worse than silently absent."

**Sharpest praise:** breaking in code the sample does not own. "`at: z_impl_k_sleep` stopping inside
the kernel from a tour attached to blinky is a teaching move nothing else in the Zephyr ecosystem can
make. Do not lose it while fixing complaint 3." Also singled out `objects:` on `CONFIG_OBJ_CORE` plus
the build's own DWARF as "the right engineering", because no hand-written struct offsets means it
survives layout changes.

### 2.2 Contributor (writes drivers for a living, one-afternoon budget)

**Verdict:** would write two tours this afternoon, cannot, and would not open a PR blind. The concept
sold them in three minutes; the authoring loop lost them at minute eight.

**Sharpest criticism:** the loop does not close without a Zephyr build. Everything that makes a tour
*wrong* is anchor resolution and expression evaluation, and neither `npm run test` nor the mock backend
touches either. Worse, `docs/tours.md:366` promises "Source excerpts come from your Zephyr workspace
when there is one" and on the demo path that is false: `startDemo()` never sets `sourceUrl`, `demoCard()`
returns `anchor: null`, `TourCard.tsx:174` renders the excerpt only under `{src && anchor?.line}`. So
there is no excerpt in dev, ever, and every `highlight:` is unverifiable.

**Sharpest praise:** "An expression names a place, and the format says how to read what is there." One
sentence and they understood the whole expression language, including why `1p` pointer-width arithmetic
exists so one tour runs on 32- and 64-bit guests. They also flagged the highest-value three-line fix in
the repo: `panel:` is an unvalidated free string (`parse.ts:458`) and `revealPanelKind()` silently
returns on zero matches, so `panel: leds` does nothing, quietly, forever.

### 2.3 Newcomer (Arduino background, 20 minutes, no debugger experience)

**Verdict:** would leave knowing Zephyr has threads and "something called devicetree", and not much else.
Stalled six times in ten cards on unexplained terms.

**Sharpest criticism:** "The tour freezes the machine before I ever see it work." Blinky's tour boots the
guest with `-S`, and card 1/5 is up before the LED blinks once. In `shots/blinky/step-01.png` the terminal
has exactly one line and the LED0 orb is grey; in `shots/surfaces/13-dts.png`, taken untoured, the terminal
is scrolling `LED state: OFF / ON / OFF`. "Your product's magic trick is a real board doing a real thing in
my browser with nothing installed. Your tour's first act is to take that away and replace it with a
paragraph about build-time macro expansion."

**Sharpest praise:** the source excerpt. "`▸` in the gutter for where we stopped, a tint for what the step
is about, and a header reading `main.c:38 in main()`. I always knew where I was." And blinky card 3, where
the highlighted `gpio_pin_toggle_dt(&led);` sits next to a purple LED0 orb: "one second" of understanding.

### 2.4 Member company (applications engineering at a silicon vendor)

**Verdict:** would put a link in a workshop invite today if a link existed. Cannot, so will not.

**Sharpest criticism:** a tour is not addressable, therefore not distributable. The deepest link is
`?board=&app=&backend=`. Meanwhile `docs/sample-docs.md` already describes a mirrored docs page per sample
with a "Run in simulator" button designed to become a Sphinx extension, and that widget cannot carry a
tour or a step. "Ten excellent tours nobody can link to are worth less to me than one tour I can put in a
workshop invite, an FAE reply, and our SDK's getting-started page."

**Sharpest praise:** blinky card 1 is "the best twenty seconds of Zephyr onboarding I have seen anywhere",
specifically the `at:`/`highlight:` split putting `▸` on line 32 and tinting line 21. They would also fund
a same-tour-two-boards comparison as "the most persuasive single argument for Zephyr that exists."

### 2.5 Trainer (3-to-5 day corporate courses, 15 people to a room)

**Verdict:** a very good demo, not a lab. "Labs are the thing my customers are actually buying."

**Sharpest criticism:** nothing is ever done, learned, or checked. Across ten steps the verbs are Watch,
Check, Open, Look for, Prefer watching. Not one step asks the learner to change anything, and the entire
directive vocabulary in `parse.ts` is read-only. Their fix is `try:` plus `check:` — an instruction to the
learner and a target expression with an expected value, evaluated at the next stop and reported pass/fail.
"A check is a watch with an assertion."

**Sharpest praise:** one URL, 15 laptops, no IT ticket, real `Zephyr v4.4.0-9375`. "That is my half-day
back." Plus card 4/5 of blinky: standing inside the kernel with a live thread list, from a stock build,
"is the exact demo I currently need a board, a probe, and a projector for."

### 2.6 Skeptic (ships Zephyr products, owns team onboarding, has watched CodeTour die)

**Verdict:** the concept is aimed at the wrong moment, and the artifact should be inverted.

**Sharpest criticism:** "Nobody's mental model of Zephyr breaks while blinky is working." Every tour
narrates a success; pressing Continue five times through code that already works produces recognition, not
knowledge, because nothing was ever at stake. Their proposal: point the engine at failure, and invert
primacy so the tour is an article the page renders with each stop as an optional "prove it on the running
target" button beside the paragraph that claims it. "Stop making me press Continue to read them."

**Sharpest praise:** `objects:` and `threads:` on a halted machine, "a view I would pay for", and precisely
because it is DWARF- and object-core-driven rather than an author's pointer arithmetic. Correspondingly
their sharpest technical objection is that `philosophers.tour.md:65-66` (`owner = $arg0+2p as ptr`) teaches
`k_mutex` struct layout by offset, two lines below an `objects:` pane that gets the identical facts right
by construction.

### 2.7 Educator (second-year RTOS course, 80 students, no TA)

**Verdict:** cannot assign it yet. Would write twelve tours for free if the on-ramp were one page long.

**Sharpest criticism:** "Hit counters are used where predicates are needed, and the prose asserts the result
anyway." They are explicit that this blocks the *voice*, not just the feature: their rewrite of philosophers
4/5 ("its neighbour is not running and not spinning, it is parked on a mutex wait queue") is unwritable
today, because the step fired on a count and the state was not guaranteed. "The voice I want is not reachable
with today's directives. That is the point."

**Sharpest praise:** the catalog economics plus the one asset going unused — `tracing_pipeline`, a packaged
multi-threaded sensor pipeline with a deliberate priority inversion, already shipping CTF, already wired to
Trace, with an `Owner base priority` column in the objects pane that is *literally the proof that priority
inheritance happened*, and no tour pointing at any of it. "Priority inversion is a named exam topic in every
RTOS course on earth and this repo has the perfect vehicle sitting unused."

### 2.8 Where they genuinely disagree

| Question | Position A | Position B | Adjudication |
| --- | --- | --- | --- |
| Is the stepper the right artifact? | **Skeptic:** invert it. Article first, stops as optional "prove it" buttons. Fixes skim, deep-link, completion, sequencing all at once. | **Trainer, educator, member company:** the freeze *is* the product; a paragraph beside a playground is a blog post with a button. | **Adopt the artifact, reject the inversion.** Ship a read-through rendering of every tour as a *peer* surface (handout for the trainer, linkable URL for the vendor, article for the skeptic's 90-second skim). Do not demote the stepper: philosophers 4/5 does not survive being an optional button. |
| How do you teach deadlock? | **Educator:** a `poke:` directive that writes to the target, removes Dijkstra's asymmetry live, and deadlocks the class's machine in front of them. "Worth ten cards describing it." | **Skeptic:** package a deliberately broken sample instead. | **Broken sample.** `poke:` puts an asterisk on "the firmware is stock, byte-for-byte", which is the project's single most valuable sentence and the reason the maintainer engaged at all. Debug → Mem already allows hand editing, so nothing is taken from an expert. A `philosophers_naive` app is deterministic, comparable against the stock app in the picker, and costs one manifest line. |
| First fix: observe, or check? | **Newcomer:** let it run before you freeze it. One card, almost free, fixes the worst moment in the product. | **Trainer:** every card ends in a task and a check, or it is a demo video. | **Newcomer first.** A lab task on a machine the reader has never seen working is a task about a black box. Both land eventually; the observe step is also a prerequisite for the intro card, the outro card, and the `dts:` step, three features sharing one small change. |
| Where do you stop for the GPIO driver lesson? | **Maintainer:** one frame higher, at the API dispatch in `include/zephyr/drivers/gpio.h`. | **Trainer, educator:** at `z_impl_gpio_pin_configure`. | **Neither, as stated.** `gpio_pin_configure` is a syscall whose `z_impl_` is a static inline in the header; on `-O2` there is very likely no symbol to break on. Verify against the shipped ELF before writing any card that depends on it. Better resolution in §5, D13. |
| Is the picker fixable with a filter? | **Trainer, newcomer:** add a guided filter or a "Start here" group to the app picker. | **Engineering audit:** the picker is a machine chooser; badging 90 alphabetical rows starting at "A2DP Source" does not make a syllabus. | **Separate Learn entry point.** Building the filter first means building it twice. Fix the `traced`-twin duplication on its own merits (it is the first screen anyone sees) and put the curriculum somewhere else. |

---

## 3. Where the personas agreed

Ranked by cost per learner. "Raised by" counts the seven persona reviews.

| # | Finding | Raised by | Severity |
| --- | --- | --- | --- |
| 1 | **Blinky steps 2 and 5 break in `gpio_virtio.c`**, this repo's own virtio driver, and the card never says so. 40% of the flagship tour teaches code that exists nowhere else. The project's own rule forbids it: `copywriting/SKILL.md`'s "Leave out" column is "How QEMU, Emscripten, or virtio is wired". Worse, `docs/tours.md:34` uses that same anchor as *the* worked example, so a contributor copies the defect first. | all 7 | Critical — credibility |
| 2 | **`when: hits == N` cannot carry a state claim, and a shipped card already over-claims.** Philosophers 4/5 fires at `hits == 6` on a shared entry point crossed by six threads and then tells the reader to "look for blocked philosophers". EVIDENCE §3.7: none were visible on the captured run. | 7 | Critical — correctness |
| 3 | **No completion, no next, no sequencing.** Blinky loops on 5/5 forever; philosophers goes silent. `finished` is computed (`store.ts:714`) and unread. Nothing orders the two tours. | 7 | High |
| 4 | **Devicetree is taught without being shown.** Blinky card 1's entire body is devicetree; the card renders C. The viewer already renders `aliases { led0 = &led0; sw0 = &button0; }` and `chosen { zephyr,console = &uart0; }` verbatim (`shots/surfaces/13-dts.png`). No directive reaches it. | 7 | High |
| 5 | **Raw values under prose that names constants.** `flags 655360 · 0xa0000` beneath three sentences about `GPIO_OUTPUT_ACTIVE` and `GPIO_ACTIVE_LOW`. `src/lib/gpioFlags.ts` already exports `formatGpioFlags()` and the dock already uses it. | 6 | High |
| 6 | **The prose points at data the card is already rendering.** "Open the thread list in **Debug** on this stop" sits four lines above the rendered thread list (`threads: yes` at `blinky.tour.md:72`). "See its owner and waiters in **Debug**" sits above the rendered objects pane. | 6 | Medium — one sentence per card |
| 7 | **The card occludes the surface it names.** `App.tsx:417` centres the card over the terminal, and both tours instruct the reader to read the terminal. Visible in `shots/philosophers/step-04.png`. | 5 | Medium |
| 8 | **The tour is not addressable.** No `tour=`, no `step=`, no copy-link. The mirrored-docs widget cannot carry one. | 4 | High for distribution |
| 9 | **One tour per sample, enforced by the filename.** `catalog.ts:26` derives the sample id from the filename, `guided.test.ts:53-59` asserts it. Blinky naturally hosts two lessons and can host one forever. | 4 | High for catalog shape |
| 10 | **Auto-start with no consent, and no replay.** `qemu.ts:310` forces `-S` whenever `hasTour()`. `store.ts:32` defines `ENABLED_KEY` and *nothing in the repo ever writes it* — a whole opt-out pathway wired end to end with no switch on the front. | 5 | Medium |
| 11 | **The `traced` twin doubles every guided row.** 90 rows for 45 samples, "Blinky · guided" twice. | 5 | Low, but it is the first screen |
| 12 | **No contributor on-ramp.** `tours/` has two files, no `TEMPLATE.tour.md`, no `tours/README.md`. Two load-bearing constraints (filename must be the `boards.ts` app id; `sample:` must be the exact `zephyrSample` string) are asserted only in `guided.test.ts:53-59` and documented nowhere. | 3 | High for catalog growth |
| 13 | **No CI resolve gate.** `west.yml:24` is `main`; `build-images.yml` has zero occurrences of `tour`. | 2 (maintainer, skeptic) | Critical, and under-raised |

**Consensus catalog wishlist.** Four tours were named by five or more personas, all packaged on
`qemu_cortex_a53` today: `hello_world` (what runs before `main`), `basic_button` (interrupt context, and
the only tour the reader triggers), `msg_queue` (producer/consumer), `tracing_pipeline` (priority
inversion). Two packaging gaps were named repeatedly: `samples/synchronization` (the canonical semaphore
lesson, absent from the manifest for A53 — the manifest mentions it only as a Cortex-M3 staller) and a
`k_work` / workqueue sample (absent entirely).

**Consensus praise, so it does not get lost in a redesign:** stock firmware; `at:`/`highlight:` split;
`objects:` from `CONFIG_OBJ_CORE`; breaking in kernel code; pattern anchors with fallbacks; freeze at reset
before attaching; one Markdown file, glob-discovered; `docs/tours.md` itself.

---

## 4. The contrarian case, taken seriously

The skeptic's argument is the sharpest thing in the review pack and it deserves a straight answer rather
than a compromise reflex. It has three separable claims.

**Claim 1: tours narrate success, and success teaches nothing.** "Nobody's mental model of Zephyr breaks
while blinky is working. It breaks when the LED does not blink and the reason is a missing `led0` alias, a
device that was not ready, a `k_msleep()` in an interrupt handler, or a 512-byte stack." This is correct
and it is not answered anywhere else in the pack. Ten of ten cards across both tours describe a system
doing what it was built to do. The newcomer's version of the same complaint is "this card taught me nothing
and made me feel stupid", and the trainer's is "my students remember the thing that broke when *they*
changed it."

**Claim 2: a stepper is the wrong container for the content.** The Markdown is already an article, and
`docs/tours.md:13-15` says so; the page never shows it. Inverting gets skim, deep-link, completion, replay
and sequencing for free, because those are all non-problems for a document. And it forces every step to
justify itself against "does stopping the machine prove something the paragraph could not?" — a test blinky's
hexdump fails and philosophers' fork table passes brilliantly.

**Claim 3: this class of tool has an eighteen-month half-life.** CodeTour, Jupyter-for-embedded, Sourcegraph
notebooks, three internal walkthrough projects. The maintainer arrives at the same place from a different
direction: 125 anchors into someone else's git history with no detection.

**What I would concede.**

Claim 2's *artifact* is right and its *primacy* is wrong. Ship the read-through view. It is a small piece of
work (render the same Markdown, one route, per-step anchors) and it independently satisfies four personas:
the trainer's printed handout, the member company's linkable URL, the educator's lab sheet, the maintainer's
"something docs.zephyrproject.org can point at". But demoting the stepper to a button loses the two moments
that are the entire justification for the machinery — philosophers 4/5's fork table and blinky 4/5's thread
list at `z_impl_k_sleep` — because a reader skimming an article does not press a button that costs them a
30-second boot. The freeze is what makes the claim checkable; that is not decoration.

Claim 1 is right and is the strongest content argument in the pack, and I would act on it *partially* and
*later*. Fully acting on it means a `broken_blinky` family: four variants (disabled node, missing alias,
256-byte stack, `k_msleep` from a callback) across three boards, a packaging and maintenance commitment
against an unproven pedagogy. Eighty percent of the lesson is reachable from stock code by anchoring at the
failure *boundary*: a card on `device_is_ready()` that names what returning false means, a card on
`z_fatal_error` reached from an illegal call. And "break when `device_is_ready` returns false" is a
predicate, so the prerequisite is the same predicate work everything else needs. Revisit after that lands.

Claim 3 is the one to act on immediately and it is not a philosophical question. The CI resolve gate (§9,
Phase 0) is exactly the anti-half-life measure, and it is the maintainer's stated precondition for an
upstream docs link.

**The owner's realistic options.**

| Option | What it means | Cost | My read |
| --- | --- | --- | --- |
| A. Status quo plus content | Write 20 more tours in the current shape | Low | Rejected. Multiplies the rot exposure tenfold with zero detection, and 20 tours nobody can link to are worth less than 1 that can be. |
| B. Keep the stepper, fix the lifecycle, add two directives | The recommendation in §9 | Medium | **Recommended.** Preserves everything all seven personas praised, removes everything six of them tripped over. |
| C. Invert to article-primary | Skeptic's proposal in full | Medium | Rejected as stated, adopted in part: ship the read view as a peer surface, not as the primary. |
| D. Pivot to failure-first | Rebuild the catalog around broken firmware | High (new samples, new predicates) | Not now. Correct instinct, wrong sequencing: it needs predicates and a working lifecycle first, and it is the natural Phase 4. |

---

## 5. Confirmed defects and gaps

Verified against source. Sizes: S ≤ ~150 lines, M ≤ ~500, L beyond.

| ID | Defect | Evidence | Impact | Fix shape | Size |
| --- | --- | --- | --- | --- | --- |
| D1 | `finished` computed, never rendered. No completion state exists. | `store.ts:106,714,733,791`; `grep finished src/components/` returns nothing | Every tour ends in dead space, the single best place to send someone to the next one | Publish a synthetic completion card from `next()` when `finished` flips; render `doc.outro` plus a `next:` link | S |
| D2 | Blinky's last step re-fires forever. | `blinky.tour.md:85-91` (`hits % 10 == 0` + `repeat: yes` + `stop: no`); `store.ts:391,541` | The same `5/5` card returns at hit 20, 30, 40 indefinitely | Content: drop `repeat:`. Engine: `plantNext()` must not re-plant a repeat step once `finished` | S |
| D3 | Tours auto-start; the opt-out pathway has no writer. | `qemu.ts:310-311` forces `-S` on `hasTour()`; `App.tsx:130-139` always loads; `store.ts:32` `ENABLED_KEY`, read at `:140`, never written anywhere in the repo | The learner never sees the sample run; no consent, no lecture-friendly clean run | Export `setEnabled`, add a control, make the freeze conditional; pair with an observe step (C7) | S |
| D4 | No replay. | `skip()` at `store.ts:730` disarms and finishes; `arm()` is only reachable from `loadFor()` on a new session; `revisit()` re-publishes a stored card only | A learner who loses the thread must reset the machine | Export `restart()` that resets `steps[].{card,hits,planted}` and re-arms | S |
| D5 | The `traced` twin doubles every guided row. | `guided.ts:18` `hasTour(sample.tracedFrom ?? sample.id)`; `SampleGallery.tsx:406` | 4 of 90 badged rows, 2 of them the same sample; first screen anyone sees | Collapse the twin into a per-row toggle | S |
| D6 | `panel:` is an unvalidated free string that fails silently. | `parse.ts:114,458` (bare `asScalar`, no `PanelKind` check); `dockReveal.ts:120-127` returns on zero matches; `guided.test.ts` never inspects it | `panel: leds`, `panel: uart`, `panel: sensors` are silent no-ops forever. Also: `reveal:` is an accepted alias documented nowhere | Export `PANEL_KINDS`, validate in `parseStep`, assert in the test | S (3 lines) |
| D7 | A stop outside the sample's `src/` silently loses its excerpt and its pattern anchors. | `boards.ts:1001-1003` hardcodes `zephyr/<target>/src/<sample>/<file>`; `build-zephyr-image.sh:260-272` copies only the sample's own `src/`; `TourCard.tsx:174`; `store.ts:595-615`. Visible as the empty card in `shots/blinky/step-04.png` | `docs/tours.md:85` advertises kernel stops with no caveat; a contributor writes a `/pattern/` anchor there and it silently never resolves | Document it today; later copy the referenced kernel files into a `src/_kernel/` bucket and add a fallback | S doc / M build |
| D8 | `arm()` overwrites and discards `plantNext()`'s failure message. | `store.ts:363` awaits `plantNext()` which publishes to `state.problems` at `:396-402`; `:379` republishes with a locally built array | "the stub refused a breakpoint at …" is written and immediately lost | Merge instead of replace | S (1 line) |
| D9 | The dev preview cannot render a source excerpt, contradicting the docs. | `docs/tours.md:366` vs `store.ts:773-810` (`sourceUrl` never set), `:812-842` (`anchor: null`), `TourCard.tsx:174`; `resolveHighlights(step, null)` at `:840` | An author cannot verify a single `highlight:` locally | Correct the sentence now; real fix is `tour:check` (§9) | S |
| D10 | Continue in the dev preview desyncs the reader from the demo timer. | `next()` at `store.ts:705-718` publishes `current: null` and awaits a `plantNext()` that finds nothing; `DEMO_STEP_MS = 3200` chain at `:801` keeps its own schedule | An author cannot dwell on a card to proofread it | Cancel and re-arm `demoTimer` when `!state.live` | S (~5 lines) |
| D11 | The card is centred over the terminal, and steps instruct the reader to read the terminal. | `App.tsx:417`; `blinky.tour.md:63`; `philosophers.tour.md:96-97`; `shots/philosophers/step-04.png` | The instruction and the obstruction are the same rectangle | `look: terminal \| dock \| dts` directive, card placement derived from it | S |
| D12 | `when:` cannot express the state a step's prose asserts. | `when.ts` takes only a hit counter; `philosophers.tour.md:84-97` asserts blocked philosophers at `hits == 6`; EVIDENCE §3.7 | A shipped card makes a claim the engine cannot guarantee. Blocks nine of the proposed 24 tours | Predicate `when:` / `until:` over the existing `expr.ts` evaluator (C4 below) | M |
| D13 | Two of blinky's five steps break in repo-authored code, unlabelled, and the docs' worked example does the same. | `blinky.tour.md:31,86` → `zephyr-module/drivers/vendor/gpio_virtio.c`; `docs/tours.md:35`; `TourCard.tsx:127-136` renders no provenance | Teaches a driver that does not exist upstream; violates the project's own copy rule at the breakpoint address, where no copy edit can reach it | See resolution below | S engine + content |
| D14 | No decode format, so bitmasks render raw under prose that names constants. | `expr.ts:196-205,357` format list; `blinky.tour.md:36`; `renderInt` at `expr.ts:257`. `src/lib/gpioFlags.ts:13` already exports `formatGpioFlags()` | The worst single moment in either tour, named by six personas | Add `as gpio-flags`, then `sensor-value`, `thread-state`, `k-timeout` | S |
| D15 | Nothing about a tour is addressable. | `App.tsx:51-63` reads `board`, `backend`, `app`; `:205-216` writes the same three | No workshop invite, no FAE email, no docs link, no bug-report channel | `?tour=&step=` plus a copy-link control; pass through the docs widget | S/M |
| D16 | Prose repeatedly points at data the card renders. | `blinky.tour.md:79` vs `threads: yes` at `:72` → `TourCard.tsx:168`; `philosophers.tour.md:70` vs `objects:` at `:60` → `TourCard.tsx:145` | Reader follows the instruction, finds nothing new, trusts the next sentence less | Style rule (§7, Field Note rule 4) plus a rewrite of both tours | S |
| D17 | `skip()` resumes before breakpoints are removed. **Lower confidence — code reading, not observed.** | `store.ts:730-735`: `void disarm(); … debug.resume()`; `disarm()` at `:435` awaits per-step removal; `claimStop()` at `:475` returns false for an unplanted step | Guest can halt with no card and no explanation. Window is small; blinky's step-5 address is crossed ~1/s | `await disarm()` before the resume | S |
| D18 | The image build ships a second, unread copy of every tour. | `build-zephyr-image.sh:254-258` copies `tours/<id>.tour.md` into the tarball; `catalog.ts:21` globs the repo and is the only loader | A stale duplicate of a file the page never reads, which is exactly the coupling `catalog.ts:1-19` argues against | Delete, or repurpose as the CI gate's input | S |

**Persona claims that do not survive checking.** Worth recording so they are not fixed twice.

- *"The outline dots are dead / there is no back."* `TourOutline.tsx:37` is `disabled={!isSeen}` — seen
  steps are clickable and `revisit()` works. They are `h-1.5 w-1.5` dots. This is a discoverability
  failure (CSS and a label), not a missing capability.
- *"225 hooks into someone else's git history"* (skeptic). There are 10 anchors across the two tours, 4 of
  them `file:line` fallbacks. Extrapolation presented as a count. The *forward* exposure at 24 tours is real.
- *"Drop the `guided` badge when a step is unresolved"* (maintainer). `isGuided()` (`guided.ts:17-19`) is a
  pure function of the file glob, evaluated before any guest boots. It structurally cannot know. The
  degraded-tour signal has to be a runtime banner on the tour's first card, which is worth building.
- *"`memory:` teaches struct layout by offset"* (skeptic). Half right. `philosophers.tour.md:65-66` does
  exactly that and should be deleted in favour of the `objects:` pane two lines above it.
  `blinky.tour.md:37-41` is a well-formed directive pointed at a bad teaching target — different problem.

**D13, resolved.** Five personas said the `gpio_virtio.c` stops must go and they are right about the
symptom. Both proposed replacements are unsafe: `gpio_pin_configure`'s `z_impl_` is a static inline in
`include/zephyr/drivers/gpio.h`, so on `-O2` there is very likely no symbol to break on at all. **Verify
against the shipped ELF before writing any card that depends on it.** The better resolution is to stop
teaching the driver model on GPIO. The browser's virtio GPIO, I2C and SPI devices are *transports*; the
drivers on top of them (`lsm6dso`, `ina219`, `spi_nor`, `pcf8523`) are stock upstream Zephyr. So teach
`compatible` → binding → `DEVICE_DT_INST_DEFINE` → init levels → `device_is_ready` on `lsm6dso` and
`spi_flash`, where every anchor is real Zephyr and every claim transfers to hardware. Blinky then keeps
**exactly one** bridge-driver stop, the one where devicetree's pin 4 arrives in `$arg1`, because that value
is board-independent and it is the only place the build-time-to-runtime loop closes for GPIO. That card
carries a provenance label and one clause naming where the same call lands on real silicon.

Adopt the maintainer's three-bucket provenance rule as a **rendering feature**, not a prose convention:
classify the resolved anchor's file at resolve time in `anchors.ts` (the path is already in
`ResolvedAnchor.file`) into `sample` / `zephyr` / `this page`, render bucket three prominently, and render
`z_`-prefixed symbols as "inside the kernel: `k_msleep()` → `z_impl_k_sleep()`". That also converts the
`z_impl_` complaint from a wart into a lesson without giving up the thing everyone wants kept.

### 5.1 Missing engine capabilities, ranked by value / cost

| ID | Capability | Unblocks | Size |
| --- | --- | --- | --- |
| C1 | Completion card, `next:`, `requires:` in front matter | Every ordered path; turns "two demos" into "a curriculum with two entries" | S |
| C2 | Deep links `?app=&tour=&step=`, copy-link control, docs-widget passthrough | Workshop invites, FAE email, docs.zephyrproject.org, bug reports, lecture bookmarks. Caveat: replay-to-step N is only honest for `when: first` on cold addresses | S/M |
| C3 | `dts:` directive (see §6) | Devicetree lessons; also gives blinky's first two cards one honest card instead of two dishonest ones | M |
| C4 | Predicate stop (`until:` / predicate `when:`) | Every concurrency tour: contention, deadlock, backpressure, priority inversion. Makes state-asserting prose *safe to write* | M |
| C5 | Decode formats (`as gpio-flags`, `sensor-value`, `thread-state`, `k-timeout`) | Every driver and sensor tour; kills D14 | S |
| C6 | Provenance labels on the card | Defuses the maintainer's strongest objection without losing kernel stops | S |
| C7 | Observe steps: a step with no `at:` | The newcomer's "one thing"; also the intro card, the outro card, and a `dts:` step before the guest executes an instruction. Three features, one small change to `parse.ts:400-404` | S |
| C8 | Many tours per sample (`tours/<slug>.tour.md` + `sample:`/`concept:`/`level:`), plus a Learn entry point | Six of the 24 proposed tours; removes the "45 samples, 2 done" framing | S schema, M UI |
| C9 | `await: user` (reader causes the stop) and `check:` (assert at the next stop) | `basic_button`, ranked #1 or #2 by four personas, needs only the first half. `check:` comes nearly free after C4 | S + S-given-C4 |
| C10 | Article mode (read-through rendering of the same Markdown) | The skeptic's skim, the trainer's handout, the educator's lab sheet, the maintainer's docs target | M |
| C11 | `look:` directive and card placement | D11 | S |

### 5.2 Explicitly not worth doing

- **A grading / LMS pipeline.** `check:` makes a card verifiable; identity, persistence and exportable
  receipts are a different product. The anti-plagiarism argument ("values differ per run") does not survive
  a group chat comparing screenshots. Deep link plus screenshot is the 90% answer at 2% of the cost.
- **`poke:` (writing to the target).** See §2.8. The stock-firmware sentence is the asset.
- **Board-diff steps (two guests side by side).** Two sessions at once for one lesson. The 90% version is a
  `dts:` step on the same node with the tour run twice, plus prose naming what changed.
- **A guided *filter* in the app picker.** Treats the symptom; C8's Learn surface is the answer.
- **The reassurance register.** Not an engine item, but kill it explicitly: `blinky.tour.md:64`, "You do not
  need to know how this board wires GPIO underneath", was flagged by four personas as condescending, false,
  and the opposite of what `copywriting/SKILL.md`'s audience section asks for.

---

## 6. Devicetree in tours

**The hypothesis is correct, and it is the most obvious hole in the feature.** All seven personas reached
it independently, from a maker's "where is pin 4 actually written down?" to a maintainer's "devicetree →
binding → compatible → driver instance → the pointer in `$arg0` is the mental model most people are
missing, and I explain it in PR review over and over."

The evidence is one screen. `blinky.tour.md:13-26` is a step titled "Nothing here says which pin" whose
entire body is about devicetree and whose card renders a C excerpt. Two clicks away,
`shots/surfaces/13-dts.png` shows the viewer rendering, verbatim:

```
chosen {
  zephyr,console = &uart0;
  zephyr,shell-uart = &uart0;
  zephyr,flash = &flash0;
};
aliases {
  led0 = &led0;
  sw0  = &button0;
};
```

That is the literal answer to the card's own question, and no directive can reach it.

It is also mostly a *rendering* job, because the parsing is already done: `src/dts/query.ts` exports
`aliases()`, `chosen()`, `byLabel()`, `byPath()`, `resolveRef()`, `prop()`, `gpioSpecs()` and `pwmSpecs()`;
`src/devicetree.ts:52` returns the running guest's parsed doc; `src/deviceTopology.ts:130` gives every dock
node a `.path` so a node resolves to a dock row; `DtsViewer.tsx:133` already renders a node with tinted
property values.

### 6.1 Proposed directive

Deliberately narrow. One node, one marked property, one claim.

```yaml
dts:
  node: led0          # alias, &label, or /leds/led_0 path; also chosen:zephyr,console
  mark: gpios         # the property this step is about
  reveal: dock        # optional: also light the matching dock row
```

Four behaviours, in priority order:

1. **Inline excerpt in the card**, in the same visual grammar as `SourceSnippet`: the node, its properties,
   the named one tinted exactly as `highlight:` tints C. Not a modal. `TourCard.tsx` gains one `<TourDts>`
   sibling next to `<TourHexdump>`.
2. **Resolve one reference hop.** `led0 = &led0` → the `gpio-leds` child → `gpios = <&virtio_gpio0 4
   GPIO_ACTIVE_HIGH>`. `resolveRef()` + `gpioSpecs()` already do this. The chain *is* the lesson.
3. **Pair the tree text with the live value on the same card.** `pin = 4` read from `$arg1` at the driver,
   next to the `4` in the `gpios` cell. Five personas asked for this in near-identical words. It also
   dissolves D14: with `GPIO_ACTIVE_HIGH` visible in the tree, `0xa0000` becomes the exercise instead of the
   obstacle.
4. **Hand off**, the way `memory:` hands off to Debug → Mem: open `DtsViewer` scrolled to and expanded on
   that node (needs a `focusPath` prop, currently absent), and pulse the matching dock row via the existing
   `revealDockRow(node.key, node.deviceClass)`.

### 6.2 Three hard rules

- **A `dts:` step must not require `at:`.** Devicetree is build-time output. Making it legal without an
  anchor (a change to `buildStep()` at `parse.ts:400-404`, which currently hard-fails a step with no `at:`)
  is what gives you the intro card, the outro card and the before-the-first-instruction card for free. This
  property is worth as much as the directive.
- **One node, one property, one claim.** A card that opens the tree at the root with 27 devices expanded
  does more damage than showing nothing. The newcomer is right that `#address-cells = <0x2>` is the most
  hostile possible first line for a beginner. The viewer already exists for browsing.
- **Every devicetree step asserts something checkable on the same card.** "Look at this tree" is not a
  lesson. The `4` in the tree next to the `4` in the dock's pin row, or next to `pin = $arg1` at the driver.

### 6.3 End to end: the card that replaces blinky's cards 1 and 2

```markdown
## led0 is an alias, and the alias points at a node

```tour
dts:
  node: /aliases#led0
  then: &led0#gpios
  reveal: dock
panel: gpio
at: gpio_virtio_pin_configure | qhg_pin_configure
watch:
  - pin = $arg1 as dec
  - flags = $arg2 as gpio-flags
```

`main.c` asks for `led0` and never names a pin. The board answers. `led0` is an alias for a node whose
`gpios` property reads `<&virtio_gpio0 4 GPIO_ACTIVE_HIGH>`: controller, pin, polarity.

That `4` is the `4` in the GPIO row of the device dock, and it is the `4` the driver is holding right
now. `flags` is `GPIO_OUTPUT | GPIO_OUTPUT_INIT_HIGH`, because the API resolved "active" against the
`GPIO_ACTIVE_HIGH` in the tree before the driver ever saw it.
```

One card, four surfaces (tree text, dock row, argument register, source), one claim, zero hexdump. That is
the thing this page can do that no other Zephyr teaching material can, and it is not expressible today.

**Kconfig, later.** `terminology.md`'s "devicetree describes hardware, Kconfig selects software" wants a
`CONFIG_*` pointer to finish the sentence, and the `.config` is not currently in the tarball, so it is a
packaging change too. Do devicetree first; revisit after.

---

## 7. Writing style

Four candidates were drafted against what the card actually renders: a ~520px prose column, inline `code`
chips, bold that survives, and a source excerpt that clips at the right edge (in `shots/blinky/step-01.png`
line 21 truncates at `GPIO_DT_SPEC_GET(LED0_NODE, gpios`).

### 7.1 The four candidates, compared

| | **Field Note** | **Lab Sheet** | **Ask First** | **Margin Note** |
| --- | --- | --- | --- | --- |
| Thesis | Every card is a finding: claim, the number that proves it, and how it goes wrong | A step is a task with a checkable outcome | Open with the belief the reader holds, then falsify it | The tour is an article; the stop is optional proof |
| Heading is | A complete assertion | The learning objective | The question | The fact |
| Length | 2 paragraphs, 80 words hard | 3 beats, 60-90 words | 3 short paragraphs, ~70 words | 3-4 sentences, ~85 words |
| Person | Subject is the code; "you" reserved for the reader's own board | Second person imperative | Second person present | Third person; "you" only for the reader's hardware |
| Reader acts | No | Mandatory, every card | Lightly | No |
| Live value | Quoted verbatim with its label | The pass criterion | The punchline, last line | A single trailing evidence sentence |
| Closes on | The failure mode | A check plus a failure signal | The answer | What transfers off this page |
| Bold | None. Code chips are the only emphasis | Exactly one on-screen label | Exactly one: the new term | None |
| Enforceable by reading the Markdown? | **Yes, all rules** | No (checks depend on `until:`) | Partly (term budget is hard to police) | No (needs the article view to exist) |

### 7.2 The same two steps, four ways

Directives are byte-identical across all four. Step A is blinky's devicetree card; step B is
`z_impl_k_sleep`.

**Field Note**

> ## The pin number is not in this file
>
> Line 21 asks for `led0` and gets back a `gpio_dt_spec`: a controller, a pin, and flags, all fixed when the
> app was built. No pin number appears anywhere in `main.c`. The GPIO row in the device dock shows what
> devicetree answered for this board: pin `4`, `OUT`, used by `Browser LED0`.
>
> That is why this source builds unchanged for a board whose LED sits on a different controller. It is also
> why a board with no `led0` alias fails to build rather than blinking the wrong pin.

> ## `k_msleep()` gives the CPU to idle
>
> `k_msleep()` is a syscall, and this is its implementation. The `z_` prefix marks kernel-internal code:
> read it, never call it.
>
> `main` still reads `running` because nothing has happened yet. One line on, the kernel takes it off the
> ready queue, arms a timeout, and picks the next ready thread, which here is `idle` at `prio 15`. Sleeping
> is legal only from a thread. In an interrupt handler the kernel asserts, and the tools you want instead
> are a `k_timer` or a work item.

**Lab Sheet**

> ## Find the pin the sample never names
>
> Read line 21. The sample asks for `led0` by name and gets a controller, a pin and flags back, decided when
> the app was built.
>
> Now search `main.c` for a pin number. There is none. Open the **GPIO** row in the device dock and read the
> pin table: pin `4`, direction `OUT`, used by `Browser LED0 · leds`. That row is devicetree's answer for
> this board, and changing boards changes the row without touching this file.
>
> If the pin table is empty, the guest has not reached the driver yet. Continue and look again.

> ## Prove that a sleeping thread is off the CPU
>
> `k_msleep()` lands here, in the kernel. It takes the calling thread off the ready queue and arms a timeout
> instead of burning cycles.
>
> Read the thread list on this card: `main` is `running`, `idle` is `active`. Press Continue, then press
> Pause within a second and open **Debug** → Threads. `idle` is the running thread now and `main` is not.
>
> If `main` is still running, you paused during the toggle rather than the sleep. Try again.

**Ask First**

> ## Which pin is this?
>
> Look at line 21, then look for a pin number. There is none.
>
> The sample asks for a name, `led0`. Something else has to turn that name into a pin, and that something is
> **devicetree**: a description of this board's hardware, read when the app was built.
>
> The answer is already on screen. In the GPIO row of the device dock, pin 4 is an output, used by
> Browser LED0.

> ## Is the CPU doing anything for the next second?
>
> No. Nothing spins here.
>
> `k_msleep()` hands the processor back to the **kernel**. The thread list still shows `main` as `running`,
> because we stopped a moment too early. One line on, `main` is parked on a timer and the kernel looks for
> the next thread that is ready.
>
> Here that is `idle`, at priority 15. For the next second, this CPU is idle's.

**Margin Note**

> ## The pin comes from devicetree, not from main.c
>
> `GPIO_DT_SPEC_GET(LED0_NODE, gpios)` expands at build time into a `gpio_dt_spec`: a pointer to the GPIO
> controller's `struct device`, a pin number, and flags. It is a compile-time constant, so `main.c` contains
> no pin number on any board. The values come from the `led0` alias in the board's devicetree, which is what
> lets this source build for a board whose LED hangs off a different controller entirely.
>
> In this build, `led0` resolves to pin 4 on `virtio_gpio0`, active high.

> ## `k_msleep()` is a syscall, not a delay loop
>
> `k_msleep()` in `include/zephyr/kernel.h` converts milliseconds to ticks and calls `k_sleep()`, whose
> implementation is `z_impl_k_sleep()` in `kernel/sleep.c`. The kernel removes the calling thread from the
> ready queue, arms a timeout, and schedules whatever is ready next. No cycles are spent waiting, which is
> the difference between an RTOS sleep and a busy loop.
>
> Only a thread may sleep. From an interrupt handler the equivalents are a `k_timer` callback or a work item
> on a workqueue. (At this stop, blinky's `main` and the `idle` thread are the only two threads that exist.)

### 7.3 Recommendation: Field Note, with one borrowed rule

**Why.**

- **It is the only one enforceable today by reading the Markdown alone.** Word cap, no bold, heading is an
  assertion, every rendered value named in the prose, closes on a failure mode: a reviewer checks all five
  without booting anything, and `guided.test.ts` can check two of them. Lab Sheet needs `until:` before it
  can be honest. Ask First needs a per-card term budget that is genuinely hard to police. Margin Note needs
  the article view, which does not exist.
- **It kills both failures every persona found independently.** Rule 3 (if a value is on the card, the prose
  names it) makes `flags 655360 · 0xa0000` unwritable: either the prose says `GPIO_OUTPUT |
  GPIO_OUTPUT_INIT_HIGH` or the row comes off the card. Rule 4 (never point at data the card renders)
  deletes "Open the thread list in **Debug** on this stop" and "See its owner and waiters in **Debug**"
  permanently.
- **It costs the newcomer least, which is counter-intuitive and I think correct.** Their complaint was not
  "too technical", it was six unexplained things: `GPIO_DT_SPEC_GET` in sentence two, "GPIO driver entry",
  "run queue"/"ready set", "bitmask on the port", "link time", `655360`. Rule 3 plus one-gloss-per-symbol
  removes all six. Ask First reads better on card one and runs out of room by card four, because a card that
  must open on a question cannot also carry a value and a failure mode in 70 words.
- **It is the voice the maintainer and skeptic will link to.** They are deciding whether the tool says true
  things. A card that closes on the failure mode has been thought about; "That is the sample in one picture"
  (philosophers 5/5) has not.

**The one imported rule.** A card *may* close on a check instead of a failure mode, when the check works with
today's UI and today's directives. The Lab Sheet step B above (Continue, Pause within a second, Debug →
Threads) is achievable right now with nothing built. Make it optional, not mandatory, so the rule does not
become the fiction that every card has a task. When `until:` and `check:` land, revisit: Lab Sheet is the
right end state, and Field Note is a strict subset of it minus the imperative.

**What it costs.**

1. **Both existing tours are rewritten, not edited.** Ten cards; every one violates rules 1, 4 and 6.
   Blinky steps 2 and 5 do not survive rule 3 at all and should be deleted rather than rewritten.
2. **One engineering dependency, and only one:** `as gpio-flags` (C5/D14). Until it lands, rule 3 bites as
   "take the row off the card", which is the correct outcome anyway.
3. **Two amendments to the copywriting skill** (see below).
4. **A word counter in `guided.test.ts`.** Rule 2 is only real if a step over 80 words fails. Three lines.
5. **It gives up what Lab Sheet has.** Field Note does not make the tour assignable, and the trainer and
   educator both want that more than they want good prose. This is picking "correct and shippable now" over
   "gradeable later".

### 7.4 Amendments required to `.cursor/skills/copywriting/`

| Rule today | Conflict | Amendment |
| --- | --- | --- |
| Voice: "Prefer second person and present tense" | Field Note demotes "you" to the reader's own hardware | Tour-specific override: the grammatical subject is the code or the kernel; "you" is reserved for the reader's board |
| Audience: "If a sentence only helps someone who already ships firmware, cut it" | The mandatory failure-mode close is written for exactly that reader | Reframe: failure modes stay. The learner who hits the failure mode is the person the sentence saves |
| `terminology.md`, emulator internals: "virtio / bridge → prefer what the learner sees" | Field Note's provenance rule requires naming repo-authored code when a stop lands in it | Add an exemption: when a stop lands in code that is not upstream Zephyr, the card says so in one clause. The better fix is not to stop there |
| Nothing forbids bold; both shipped tours lean on it heavily | New rule, not a conflict | No bold in tour prose. Costs a rewrite of both existing tours |
| "No em dashes" | None | Keep. It cost nothing across eight drafts |

### 7.5 The `tour-writing` skill document

Sits next to `copywriting/`, references it rather than restating it. ~150 lines, not 400: `docs/tours.md`
documents the machine, this documents the craft.

```
.cursor/skills/tour-writing/
  SKILL.md
  step-shapes.md
  TEMPLATE.tour.md
```

**SKILL.md sections.** Frontmatter triggering on `tours/*.tour.md`, stating that `copywriting/SKILL.md` and
`terminology.md` still apply in full · What a tour is for (a tour teaches one *concept* using a sample as
the vehicle; a step that teaches the sample gets cut) · Pick the concept, then the sample (test: could a
different packaged sample teach this better? point at `tools/samples.manifest`) · Shape of a tour (4-6
steps, one concept, opens on an orientation step, closes on a closing step, declares `next:`) · Shape of a
step (the six Field Note rules, each with a before/after from the current blinky tour) · The word budget (80
words, and why the ~520px column is the real constraint) · Naming things (symbol first with one gloss; same
word forever; the `z_` clause; the not-upstream clause) · **Choosing what the card shows** (decision table:
`watch:` when one number is the lesson; `objects:` whenever the kernel already tracks the thing, always over
hand-rolled pointer arithmetic; `threads:` when the lesson is who is running; `memory:` only when the
debugger is the subject; `registers:` almost never. Rule: every rendered value must be named in the prose,
so adding a directive is a promise to spend words on it) · **Choosing where to stop** (prefer symbol
anchors; pattern anchors need the `|` fallback; never stop in code this repository authored; a stop outside
the sample's own `src/` has no excerpt and cannot use a pattern anchor) · Things you may not write (the
banned list, with the real examples) · Checking a draft · When to flag for human review.

**step-shapes.md** — the section that will actually get used, because "what is this card for" is where
contributors get stuck, not "what tense".

| Shape | One line | Available today? |
| --- | --- | --- |
| Orientation | Opens the tour, names the concept and what will be true by the end | No — needs C7 |
| Value reveal | One number is the lesson: name it, say where it came from, say what another board shows | Yes |
| Misconception | Open on the belief, falsify it with the frozen machine. Reserved for costly wrong models | Yes |
| Structure | The card shows the kernel's own bookkeeping and the prose reads one row out loud | Only honestly with C4 |
| Do it yourself | The reader changes something and checks the result | Partly (dock, Pause, Debug); fully with C9 |
| Closing | Three bullets of what you now know, the named next tour, one link out | No — needs C1 |

**TEMPLATE.tour.md** — a real four-step skeleton in the winning voice, with `sample:` called out as
load-bearing and validated (a constraint currently discoverable only from `guided.test.ts:53-59`) and each
step pre-labelled with its shape.

---

## 8. The tour catalog

Six concept tracks replacing the sample-keyed index. Rationale: the catalog is currently keyed by sample
(`catalog.ts:26`), so its shape is "45 samples, 2 done" — an infinite backlog with no editorial spine and a
hard cap of one lesson per sample. Nobody wants a tour of blinky; they want to know why their thread never
runs. Tracks are prerequisite chains through concepts, each picking whichever packaged sample is the best
vehicle, and a sample may host more than one tour.

**Effort key:** `MD` = pure Markdown against today's engine and today's images · `ENG` = needs a new engine
capability (the C-number is named) · `SAMPLE` = needs a new packaged sample.

**Prerequisites:** Track 1 has none. Track 2 requires Track 1's `hello_world`. Track 3 requires Track 2 in
full. Track 4 requires only Track 1 and runs in parallel with 2 and 3. Track 5 requires 2 and 3. Track 6
requires 1 and 2.

### Track 1 — First hour: what an RTOS gives you

*Audience: Arduino background, or an embedded engineer who has never opened Zephyr. Twenty minutes, no
install. Objective: explain to a colleague what Zephyr does that a superloop does not.*

| Tour | Sample id | Packaged | Concepts | Effort |
| --- | --- | --- | --- | --- |
| Your `main()` is not the beginning | `hello_world` | yes (all 3 boards) | boot sequence, `SYS_INIT` levels, main as a thread, `chosen` nodes, `printk` and the console device | ENG (C7 observe, C3 `dts:`) |
| Your code names a thing, the board says where it is | `blinky` | yes | aliases, node properties and phandle cells, `GPIO_DT_SPEC_GET`, logical vs physical level | ENG (C3, C5, C6, C7) |
| Something happened while nothing was running | `basic_button` | yes (all 3) | GPIO input, interrupt configuration, callback registration, interrupt context, what is illegal in an ISR | **MD** |
| Talk to the board without writing code | `shell` | yes | shell as a thread, linker-section command tables, `device list` and devicetree, driving I2C by hand | ENG (C9 `await:`) |

**Steps for tour 1 (`hello_world`):**

1. *"That is the sample, running"* — no anchor, run free 6s then freeze. Prose only, terminal in focus.
   Teaches: everything after this is that same machine, stopped, and nothing about the image changed.
2. *"The console was up before your code was"* — `at: z_sys_init_run_level`, `watch: level = $arg0 as dec`,
   `threads: yes`. Teaches `PRE_KERNEL_1` / `PRE_KERNEL_2` / `POST_KERNEL` / `APPLICATION`.
3. *"Which uart is the console?"* — `dts: /chosen#zephyr,console`, `panel:` reveals the uart0 dock row.
   One line of devicetree is the entire answer to why `printk` reaches the terminal.
4. *"`main` is a thread somebody created for you"* — `at: main.c:/Hello World/ | main.c:/printf/`,
   `threads: yes`. `idle` is already in the list and existed before `main` did.
5. *"`printk` is a kernel call, not a library call"* — `at: printk`, `watch: format = $arg0 as string`,
   `panel:` uart row. Why it works before `main` and why it is expensive in an interrupt handler.

**Note on `basic_button`:** this is the only MD-today tour in Track 1 and four personas ranked it #1 or #2.
The reason is causality: SW0 is clickable in the dock, so the *reader* causes the stop, and on A53 the
sample is genuinely interrupt-driven (`boards.ts` notes the virtio GPIO device offers `VIRTIO_GPIO_F_IRQ`).
The callback lives in the sample's own `src/`, so a pattern anchor plus `threads: yes` is enough. **Write
this one first.**

### Track 2 — Threads and scheduling

*Objective: predict what runs next. Read a thread list and a Trace timeline and say which thread is
running, which is ready, which is blocked, and why.*

| Tour | Sample id | Packaged | Concepts | Effort |
| --- | --- | --- | --- | --- |
| Sleeping is a scheduling decision | `blinky` | yes | ready queue, `k_msleep` and timeouts, the idle thread, timeout expiry in interrupt context, context switch | ENG (C8 many-per-sample) |
| Six threads, six stacks, one CPU | `philosophers` | yes | `k_thread_create`, `K_THREAD_STACK_ARRAY_DEFINE`, `K_FOREVER` and `k_thread_start`, cooperative vs preemptible, stack high-water | **MD** |
| The scheduler, drawn | `tracing` | yes | CTF events, thread lanes, gaps mean blocking, reading a timeline you did not write | **MD** |

**Steps for tour 1 (`blinky`, scheduling):** (1) "You wrote one thread. There are two." at
`main.c:/k_msleep/`, `threads: yes`. (2) "`k_msleep` is a kernel call, not a delay loop" at `z_impl_k_sleep`,
`when: first`. (3) "Leaving the ready queue" at `z_pend_curr | z_impl_k_sleep`. (4) "`idle` is a real
thread" at `idle`, `registers: pc, sp`. (5) "The timer brings it back" at `z_thread_timeout |
z_ready_thread` — the wakeup did not happen in any thread. (6) "One blink is two switches" at
`main.c:/gpio_pin_toggle_dt/`, `when: hits == 3` — predict the thread list before you look.

The `tracing` tour must come **last** in this track: the priority-inversion tour in Track 3 assumes the
reader can already read a lane and a gap.

### Track 3 — Sharing state without breaking it

*Objective: choose the right primitive and predict what happens when it is contended. Recognise deadlock and
priority inversion from a thread list and a timeline. Strict internal order: semaphore → mutex → deadlock →
message queue → priority inversion → work queues.*

| Tour | Sample id | Packaged | Concepts | Effort |
| --- | --- | --- | --- | --- |
| A semaphore is a counter you can wait on | `synchronization` (proposed) | **no** | `k_sem_take`/`give`, counting vs binary, blocking, `K_NO_WAIT` vs `K_FOREVER` | SAMPLE |
| A fork is a mutex, and waiting is not spinning | `philosophers` | yes | ownership, lock depth, wait queues, recursive locking, the Dijkstra asymmetry | ENG (C4 predicates) |
| Watch it deadlock, then watch it not | `philosophers_naive` (proposed) | **no** | deadlock, circular wait, why the kernel cannot help, lock ordering | SAMPLE |
| Passing data instead of sharing it | `msg_queue` | yes | `K_MSGQ_DEFINE` and ring storage, copy by value, backpressure and `-ENOMSG`, blocking consumer, `put_front` | **MD** |
| Priority inversion, caught in the act | `tracing_pipeline` | yes | inversion, inheritance, owner base vs current priority, contention in a timeline | ENG (C4) |
| Do it later, in a thread | `workqueue` (proposed) | **no** | `k_work` / `k_work_delayable`, the system work queue is a thread, submitting from an ISR, one pending submission | SAMPLE |

**Steps for tour 1 (`synchronization`, once packaged):** (1) "Two threads, one token" at
`main.c:/k_sem_take/`, `objects: sem`. (2) "Taking a token that is not there" at `z_impl_k_sem_take`,
`objects: sem` with `focus: $arg0`. (3) "Blocked, not spinning" at `z_pend_curr` — on the semaphore's wait
queue, off the ready queue, CPU went elsewhere. (4) "Give wakes exactly one" at `z_impl_k_sem_give`. (5)
"`K_NO_WAIT` is a different function" at `z_impl_k_sem_take`, `when: hits == 5` — returns `-EBUSY`; not
checking the return is a race.

The semaphore goes first because a mutex is a semaphore plus ownership plus a priority policy, and teaching
the compound thing first is how people end up using a mutex as a signal.

**`msg_queue` is the one shippable-today tour in this track.** Producer and consumer rates are
`k_sleep`-driven, so hit counts are reliable enough; the predicate gate is an upgrade, not a blocker. The
`objects:` pane already renders `used` against `capacity`, so backpressure is a table rather than a
paragraph.

### Track 4 — How software finds hardware

*Objective: follow the chain from a devicetree node with a `compatible`, through the binding and
`DEVICE_DT_INST_DEFINE`, to a `struct device` you call, to real bytes on a bus. This is the track an FAE
hands a customer.*

| Tour | Sample id | Packaged | Concepts | Effort |
| --- | --- | --- | --- | --- |
| From `compatible` to a device you can call | `lsm6dso` | yes | compatible and bindings, `DEVICE_DT_INST_DEFINE`, init levels and dependency order, `DEVICE_DT_GET` vs `device_is_ready` | ENG (C3) |
| Where a sensor reading comes from | `ina219` | yes | `sensor_sample_fetch` / `sensor_channel_get`, `struct sensor_value` fixed point, one transaction per fetch, attributes | **MD** |
| Erase is not write | `spi_flash` | yes | flash API, erase granularity, program only clears bits, partitions from devicetree, SPI traffic | **MD** |
| The same C, a different board | `blinky` | yes | portability, board-specific devicetree, pointer width and ABI, what actually changes when you port | ENG (C8 + cross-board session) |

**Steps for tour 1 (`lsm6dso`):** (1) "A node that says what it is" — `dts: &lsm6dso#compatible`, also mark
`reg`, `panel: i2c`. (2) "The instance devicetree created" at `lsm6dso_init`, `watch: device name = *$arg0
as string` — `DEVICE_DT_INST_DEFINE` made exactly one `struct device` for that node and `$arg0` is it. (3)
"Init order is not luck" at `z_sys_init_run_level` — the I2C controller initialises before the sensor
because the driver declares the dependency through devicetree. (4) "Build time and run time are different
questions" at `main.c:/device_is_ready/ | main.c:/DEVICE_DT_GET/` — `DEVICE_DT_GET` always succeeds;
skipping `device_is_ready` is the most common first-driver bug. (5) "One binding, many instances" — a second
node with the same compatible; adding a chip is a devicetree edit, not a code edit.

**This track is the resolution to the `gpio_virtio.c` problem.** `lsm6dso`, `ina219` and `spi_nor` are stock
upstream drivers sitting on the browser's transports, so every anchor is real Zephyr and every claim
transfers to hardware. `ina219` is deliberately a different sample from the binding tour so neither depends
on C8. `spi_flash` is also the one tour where a `memory:` hexdump is the argument rather than decoration:
erased flash reads `0xff`, and a write can only clear bits.

### Track 5 — Seeing inside a running system

*Objective: answer a question about a running system nobody narrated for you.*

| Tour | Sample id | Packaged | Concepts | Effort |
| --- | --- | --- | --- | --- |
| Find it yourself: a debugger clinic | `shell` | yes | setting your own breakpoint, thread list as evidence, hexdump and ASCII, registers vs memory, the object registry | ENG (C9 `try:`/`check:`) |
| Reading a trace when you did not write the code | `tracing_pipeline` | yes | timeline as evidence, finding the gap, queue depth, turning an observation into a claim | ENG (C4, C8) |
| Four ways blinky fails | `broken_blinky` (proposed) | **no** | device readiness, missing alias, stack overflow, illegal call from an ISR, reading a fatal error | SAMPLE |

**Steps for tour 1 (`shell` clinic):** (1) "Stop the machine yourself" — no anchor, the reader sets a
breakpoint in Debug. (2) "Which thread has the least stack left?" at `shell_execute_cmd`, `threads: yes`
plus `try:`/`check:` — the first card in the catalog that grades an answer. (3) "What is this pointer?" —
`watch: cmd = $arg1 as string` next to `memory:` at `$arg1` with the string marked. (4) "Registers and
memory are two views of one machine" — `registers: pc, sp` and `memory:` at `$sp`. (5) "Everything the
kernel knows it owns" — `objects: all`, nobody typed an address. (6) "Prove it: which mutex is held right
now?" — `objects: mutex`, `check:`.

This is the legitimate home of `memory:` and `registers:`, which are currently spent on a driver struct in
blinky where they teach nothing.

### Track 6 — Subsystems you will actually ship

*Objective: know what it costs to add a real subsystem: configuration source, threads created, what blocks,
what the traffic looks like.*

| Tour | Sample id | Packaged | Concepts | Effort |
| --- | --- | --- | --- | --- |
| It remembers: a filesystem on a flash chip you can watch | `littlefs` | yes | fs API, mount points, partitions from devicetree, filesystem traffic becomes flash traffic, persistence | **MD** |
| Getting an address | `dhcp` | yes | `net_if`, the stack's own threads, `net_mgmt` events, the DHCP exchange, packet capture | **MD** |
| A socket is a file descriptor | `http_get` | yes | BSD sockets, DNS, blocking calls block a thread, receive buffers, closing | **MD** |
| Advertise, connect, notify | `bt_peripheral` | yes | `bt_enable` and host threads, advertising, connections as objects, GATT as a static table, notifications | **MD** |

**Steps for tour 1 (`littlefs`):** (1) "Where the partition came from" at `main.c:/FIXED_PARTITION|
storage_partition/` — no offset or size in this file. (2) "Mounting is a real operation" at `fs_mount`,
`panel: spi` — mount reads the medium and can fail; first-boot format is why run one is slower. (3) "Every
file write is flash traffic" at `spi_nor_write`, `when: first` — four layers, one call, all visible. (4)
"Reading the counter back" at `fs_read`, `memory:` at the destination buffer. (5) "Reload the page" — the
counter continues, because the dock persists the flash. The payoff is verified by the reader, not asserted
by a card.

**`bt_peripheral` lands the linker-section pattern for the third time** (`SHELL_CMD_REGISTER`,
`DEVICE_DT_DEFINE`, `BT_GATT_SERVICE_DEFINE`), which by that point in the curriculum is a recognition rather
than a new idea.

### 8.1 Effort accounting

| Bucket | Count | Tours |
| --- | --- | --- |
| **Pure Markdown, shippable today** | 10 | `basic_button`, `philosophers` (threads/stacks), `tracing`, `msg_queue`, `ina219`, `spi_flash`, `littlefs`, `dhcp`, `http_get`, `bt_peripheral` |
| Blocked on a directive (C3/C4/C7/C9) | 7 | `hello_world`, `blinky` (devicetree), `shell` ×2, `philosophers` (mutexes), `tracing_pipeline` ×1, `lsm6dso` |
| Blocked on C8 or cross-board sessions | 3 | `blinky` (scheduling), `blinky` (portability), `tracing_pipeline` (method) |
| Needs a new packaged sample | 4 | `synchronization`, `philosophers_naive`, `workqueue`, `broken_blinky` |

**Ship the ten Markdown-only tours first.** You get a real catalog in six weeks and you learn the voice on
cheap material before spending it on blinky.

### 8.2 New samples to package

| Proposal | Path | Cost | Why |
| --- | --- | --- | --- |
| `synchronization` | `samples/synchronization` on `qemu_cortex_a53` | one manifest line + one `boards.ts` entry | The canonical semaphore lesson; nothing packaged teaches `k_sem` as its primary subject. The manifest mentions this sample only as a Cortex-M3 staller; A53 uses the wasm JIT and has no such limit, so this is close to free |
| `philosophers_naive` | `zephyr-module/apps/philosophers_naive` | ~50-line diff from upstream + manifest line + gallery entry | The stock sample is specifically the version that cannot deadlock, so `philosophers.tour.md:42` asserts a failure it can never show. Deterministic, comparable against the stock app in the picker, cheaper and safer than `poke:` |
| `workqueue` | `zephyr-module/apps/workqueue_deferred` | one purpose-built app + manifest line | Nothing teaches `k_work`; deferred work is the answer to half the questions the button tour raises. Build it against the `browser_bridge` button so the reader still causes the event |
| `broken_blinky` | `zephyr-module/apps/broken_blinky`, 4 Kconfig variants | one app, four variants, four manifest lines, a gallery group | The skeptic's argument. Highest-value new build, and also the least proven. See §4 |
| Logging | `samples/subsys/logging/logger` or similar | one manifest line | Flagged by the maintainer, not scheduled. First thing every real application turns on; deferred-mode log processing is a good scheduling lesson |
| Power management | not identified | new sample + dock modelling | Real gap for a module vendor, nothing in the manifest covers it. Park until the idle-thread tour exists |

### 8.3 Anchor risks to verify against a real ELF before writing cards

Sample sources are copied only for the sample's own `src/` (`build-zephyr-image.sh:260-272`), so every
kernel and driver stop above is a bare symbol anchor with **no excerpt and no pattern anchor** (D7).
Specific symbols to check before committing prose to them: `z_shell_cmd_get` (riskiest in the catalog),
`work_queue_main` and `k_work_schedule_for_queue` (may be static or renamed), `z_pend_curr` (used in nine
proposed tours — if inlined, a lot of steps move to `z_impl_k_sleep` / `z_impl_k_mutex_lock`), `idle`,
`z_thread_timeout`, `z_impl_k_msgq_put_front`, the `zsock` `z_impl_` forms, and `z_impl_gpio_pin_configure`
(likely a static inline with no symbol at all — see D13).

**Provenance of `tracing_pipeline`: settled — it is upstream.** Two personas assumed it was repo-authored,
because `boards.ts:610-618` describes it as a purpose-built pipeline with deliberate contention. It is not:
`zephyrproject-rtos/zephyr@main` carries `samples/subsys/tracing/{basic,pipeline}`, and `west.yml:24` tracks
upstream `main` with no fork. Every card on it may say "upstream" without a provenance label. That makes it
a *better* vehicle than the personas thought, not a worse one.

---

## 9. Action plan

### Phase 0 — This week. Stop the bleeding, unblock everything else.

*Goal: the feature has a lifecycle and the build refuses to ship a broken anchor. All items are S.*

1. **CI resolve gate in `.github/workflows/build-images.yml`.** After the build, before packaging: walk
   `tours/*.tour.md`, resolve **every alternative of every `at:`** (not just until one succeeds), fail on any
   anchor where nothing resolves, and **fail when a pattern alternative fails while its numeric fallback
   succeeds** — that is the case that manufactures a confidently wrong card. Also resolve every `highlight:`
   pattern, warn when a resolved anchor's file is outside the sample's `src/` (D7), and record each anchor's
   resolved address, `file:line` and the Zephyr SHA next to the image. `resolveAnchor` (`anchors.ts:91`) is
   pure over an `AnchorContext`; the workflow already holds the ELF, the `.debug_line` and the sources.
2. **Completion card + `next:` in front matter** (D1/C1). `finished` is already computed.
3. **Fix blinky's looping step** (D2): drop `repeat:`, and make `plantNext()` refuse to re-plant once
   `finished`.
4. **Validate `panel:` against `PanelKind`** (D6) and assert it in `guided.test.ts`. Three lines.
5. **Merge instead of replace in `arm()`** (D8). One line.
6. **`await disarm()` before the resume in `skip()`** (D17). One line.
7. **Documentation truth pass:** correct `docs/tours.md:366` about dev-mode source excerpts (D9); add the
   paragraph saying a stop outside the sample's `src/` has no excerpt and cannot use a pattern anchor (D7);
   replace the worked example at `docs/tours.md:34` so it does not anchor in `gpio_virtio.c` (D13).
8. **Delete or repurpose the tarball's unread tour copy** (D18).

**Exit criterion:** an image build fails when a tour anchor breaks; a learner who reaches the last step sees
a completion card with a next link; no shipped example anchors in repo-authored code.

### Phase 1 — Weeks 2-4. Decide the voice, open the door for contributors.

*Goal: someone other than the owner can write a correct tour in an afternoon. Size: S-M.*

1. **Adopt a voice** (§7). This is a decision, not work, and it gates everything downstream — do not write
   fifteen tours and then change it. Recommendation: Field Note plus the optional check close.
2. **Write `.cursor/skills/tour-writing/`** (SKILL.md, step-shapes.md, TEMPLATE.tour.md) and the two
   `terminology.md` amendments (§7.4).
3. **`npm run tour:check <file>`** (§3.1 of the engineering audit): fetch the pinned image tarball, resolve
   every `at:` and every alternative, report which won and where it landed, check `highlight:` patterns
   against the shipped sources, tokenize every `watch:` expression and confirm bare symbols exist in
   `.symtab`, validate `panel:`, warn when a step uses `$argN` and its anchor did not resolve via a symbol
   at zero offset. Everything it needs is already pure code in `anchors.ts`, `dwarfLines.ts`, `expr.ts`.
4. **Word-count lint in `guided.test.ts`**, once the voice is agreed.
5. **`tours/README.md`** documenting the two load-bearing constraints nobody has written down (filename must
   be the `boards.ts` app id; `sample:` must be the exact `zephyrSample` string).

**Exit criterion:** a contributor with no Zephyr build can write a tour, run one command, and know whether
every anchor resolves before opening a PR.

### Phase 2 — Weeks 3-8, overlapping Phase 1. Ship the ten free tours.

*Goal: a catalog that exists. Size: prose only, no engine work.*

Write, in this order, in the agreed voice, one at a time with a read-through each:
`basic_button` → `msg_queue` → `philosophers` (threads and stacks) → `ina219` → `spi_flash` → `tracing` →
`littlefs` → `dhcp` → `http_get` → `bt_peripheral`.

`basic_button` first because four personas ranked it top and it is the only tour where the reader causes the
stop. `msg_queue` second because it is the first thing anyone builds after threads and the `objects:` pane
already renders `used`/`capacity`.

**Dependency to respect:** these ten must not be written before Phase 1 item 1. Rewriting ten tours because
the voice changed is the single most avoidable cost in this plan.

**Exit criterion:** twelve tours in `tours/`, all passing the resolve gate, all in one voice.

### Phase 3 — Weeks 4-10, in parallel. Build the two directives that matter.

*Goal: the lessons that are currently unwritable become writable. Size: M each.*

1. **`dts:`** (C3, §6). Ship with the observe-step change (C7) that makes it legal without an `at:`, because
   they are the same change to `parse.ts:400-404`.
2. **Observe steps + opt-in boot** (C7/D3): finish the `ENABLED_KEY` pathway that is already wired at both
   ends, and make `-S` conditional on the reader's answer.
3. **Deep links** (C2/D15) plus a copy-link control, then pass the params through the `docs/sample-docs.md`
   widget.
4. **Decode formats** (C5/D14), starting with `as gpio-flags` over the existing `formatGpioFlags()`.
5. **Provenance labels** (C6/D13).
6. **`look:` and card placement** (C11/D11), and the `traced`-twin collapse (D5).
7. **Predicate `when:` / `until:`** (C4/D12). Ship it with a documented cost model and a rejection budget:
   `docs/tours.md:118-136` makes a careful argument that a rejected hit costs one register read and a
   continue, and a predicate that reads memory costs several round-trips per rejected hit. That is fine on a
   cold breakpoint and genuinely not fine on `z_impl_k_mutex_lock` at thirty locks a second.

**Exit criterion:** a card can show a devicetree node next to the live value derived from it, and a step can
stop when a mutex has both an owner and a waiter.

### Phase 4 — Weeks 8-16. Rewrite the flagship tours, then expand.

*Goal: the two existing tours stop being liabilities, and the catalog gets the lessons only this page can
teach. Size: mixed.*

1. **Rewrite `blinky`** into the Track 1 devicetree tour (5 steps, one bridge-driver stop with a provenance
   label, no hexdump) and, once C8 lands, split the scheduling half into its own Track 2 tour.
2. **Rewrite `philosophers`** into the Track 3 mutex tour with every card gated on a predicate. Do not do
   this before C4; the prose the educator wants is not reachable otherwise.
3. **`tracing_pipeline` priority inversion** — the tour every persona wanted and the one only this project
   can ship.
4. **Many tours per sample** (C8): `tours/<slug>.tour.md` with `sample:`/`concept:`/`level:`/`requires:`/
   `next:`, a reverse index in `catalog.ts`, and a **Learn** entry point outside the app picker.
5. **Package `synchronization`** and the workqueue app; write both tours.
6. **Article mode** (C10) as a peer surface: read view, per-step anchors, "Read this tour" from the card and
   the gallery.
7. **`await: user`** (C9 first half), then `check:` once C4 exists.

**Exit criterion:** ~18 tours across five tracks, an ordered path, a Learn surface, and a linkable read view.

### Phase 5 — Later, revisit with evidence.

`broken_blinky` and the failure-first thesis (§4), Kconfig steps, board-diff, power management, logging.
Each of these should be re-argued once there is usage data from a real catalog, rather than scheduled now.

---

## 10. Open questions for the owner

1. **Do tours stay stepper-primary?**
   *Options:* (a) stepper only, as today; (b) stepper primary with a read-through view as a peer;
   (c) article primary with optional "prove it" buttons (the skeptic's proposal).
   **Recommendation: (b).** It satisfies the trainer's handout, the vendor's link, the educator's lab sheet
   and the maintainer's docs target without demoting the two moments (`philosophers` 4/5, `blinky` 4/5) that
   justify the machinery.

2. **Sample-keyed or concept-keyed catalog?**
   *Options:* (a) keep `tours/<sample-id>.tour.md`; (b) `tours/<slug>.tour.md` with `sample:` in front
   matter, many-to-one, plus `concept:`/`level:`/`requires:`/`next:`.
   **Recommendation: (b).** Blinky hosts two natural lessons and today can host one forever. This also
   changes the catalog's framing from "45 samples, 2 done" to "six tracks, N complete". Cost: a schema
   change plus one `guided.test.ts` assertion.

3. **Which voice?** Field Note / Lab Sheet / Ask First / Margin Note (§7).
   **Recommendation: Field Note plus the optional check close.** It is the only one enforceable by reading
   the Markdown, and it kills the two failures every persona found independently. Decide this *before*
   Phase 2, not during it.

4. ~~**Is `tracing_pipeline` upstream or repo-authored?**~~ **Answered: upstream.**
   `zephyrproject-rtos/zephyr@main` carries `samples/subsys/tracing/pipeline`, and `west.yml:24` tracks
   upstream `main` with no fork, so `tools/samples.manifest:93` is accurate and two personas were wrong to
   assume otherwise. No provenance label needed; both proposed tours can claim upstream. No decision
   required from you.

5. **Do we spend build slots on new samples, and which?** Four are proposed (§8.2).
   **Recommendation: `synchronization` now** (one manifest line, unblocks a whole track's opening),
   **`workqueue` in Phase 4** (closes the ISR lesson the button tour opens), **`philosophers_naive` in
   Phase 4** (deterministic deadlock, cheaper than `poke:`), **`broken_blinky` deferred** pending evidence.

6. **Does `poke:` ever ship?** The educator's deadlock demo is the most instructive single idea in the pack,
   and it puts an asterisk on "the firmware is stock, byte-for-byte".
   **Recommendation: no.** That sentence is the project's most valuable asset. Ship
   `philosophers_naive` instead. Debug → Mem already lets an expert edit by hand.

7. **How far does assessment go?** `check:` on a card, or persisted answers and exportable receipts?
   **Recommendation: `check:` and stop.** A submission pipeline is a different product. The deep link plus a
   screenshot is the 90% answer for the educator at 2% of the cost.

8. **Does the app picker get a guided filter, or does the curriculum move out?**
   **Recommendation: move it out.** Fix the `traced`-twin duplication on its own merits (D5), and build the
   Learn surface once rather than a filter now and a surface later.

9. **Who owns tour freshness when upstream moves?** The CI gate turns a silent break into a red build, but
   someone still has to fix the anchor.
   **Recommendation:** record the resolved address, `file:line` and Zephyr SHA per anchor alongside each
   image (Phase 0 item 1), so a failure report reads "step 4 of blinky moved from `sleep.c:92` to
   `sleep.c:97` between SHA A and B". That is a diff on an artifact, not a debugging session, and it is what
   makes the maintenance load survivable at 20 tours.

10. **Do you take the maintainer's offer on decode tables?** They offered that upstream subsystem people
    would review the per-subsystem decode tables for C5 ("they are short and they are the kind of thing we
    can check").
    **Recommendation: yes, and use it as the first upstream contact.** It is a small, concrete, low-risk ask
    that starts the relationship that a `docs.zephyrproject.org` link eventually needs.
