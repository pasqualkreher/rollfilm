// In-app user guide. Content is maintained by hand - keep it in sync with the
// actual features (this is what "Help" in the nav and the first-run welcome
// guide point at).
//
// Structure mirrors Settings: nineteen headings in one scroll was a page you
// had to read to search. The same material now sits in seven chapters, one
// visible at a time, and every topic in a chapter has the same shape - where
// to find it, one sentence saying what it is, then the detail. That way a
// question can be answered by picking a chapter and skimming lead sentences,
// without reading the guide.

import { useRef, useState } from "react";
import type { ReactNode } from "react";

// ---- Building blocks so every topic reads the same way --------------------

// The path to the thing being described, e.g. "Import → Import photos".
function Where({ children }: { children: ReactNode }) {
  return (
    <p className="help-where">
      <span className="help-where-label">Where</span>
      <span>{children}</span>
    </p>
  );
}

// A short aside: the one thing worth remembering about the topic above it.
function Tip({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="help-tip">
      <strong>{title}</strong> {children}
    </div>
  );
}

interface Topic {
  id: string;
  title: string;
  where?: ReactNode;
  // One sentence, in plain words: what this is and what it is for. Every topic
  // has one, so the chapter can be skimmed by reading only these.
  lead: ReactNode;
  body?: ReactNode;
}

interface Chapter {
  id: string;
  label: string;
  blurb: string;
  topics: Topic[];
}

const CHAPTERS: Chapter[] = [
  // ---------------------------------------------------------------- start --
  {
    id: "start",
    label: "Start here",
    blurb: "What the app does with your photos, and the shortest way from a full memory card to a finished picture.",
    topics: [
      {
        id: "how-it-works",
        title: "How Rollfilm works",
        lead: (
          <>
            Rollfilm never changes your photo files. It copies them into one library folder and
            keeps everything it learns about them — stars, tags, albums, edits — right beside them.
          </>
        ),
        body: (
          <>
            <ul>
              <li>
                <strong>One folder holds everything.</strong> The folder you picked on first start.
                Imported photos are copied into it, and the database, thumbnails and import staging
                sit next to them in a hidden <code>.photomanager</code> subfolder. Copying that one
                folder copies your whole library, with all the work in it.
              </li>
              <li>
                <strong>Edits are notes, not new files.</strong> An edit is stored as a list of
                settings; what you see is rendered from the original every time. So you can change
                your mind years later, "Reset" really does bring the photo back, and a finished
                JPEG only exists once you export or save a copy.
              </li>
              <li>
                <strong>Deleting has a safety net.</strong> Photos go to the Trash first and can be
                restored with everything they had. Only "Delete forever" touches a file on disk.
              </li>
              <li>
                <strong>You can have several libraries.</strong> Point the app at a different folder
                under <em>Settings → Library → Library folder</em> and it opens that one instead.
                No photo files are moved; the app restarts.
              </li>
              <li>
                <strong>Almost nothing lives outside that folder</strong> — only the AI model cache
                and the log files, in the usual place for app data. They look after themselves.
              </li>
            </ul>
            <Tip title="The disk is the truth.">
              If photos disappear from the library folder (deleted outside the app, drive
              unplugged), run <em>Settings → Maintenance → Sync database to library</em>. It
              reconciles the app with what is actually there.
            </Tip>
          </>
        ),
      },
      {
        id: "first-steps",
        title: "From memory card to finished photo",
        lead: <>Five steps. Everything else in this guide is a detour off one of them.</>,
        body: (
          <>
            <ol>
              <li>
                <strong>Import.</strong> <em>Import → Import photos → Choose folder…</em> and pick
                the card. The files are copied into a staging area first — nothing is in your
                library yet.
              </li>
              <li>
                <strong>Pick the keepers.</strong> Still on that review screen: give stars and
                color labels, untick what you don't want, then press{" "}
                <strong>Add … photos to library</strong>.
              </li>
              <li>
                <strong>Find them again.</strong> The <strong>Library</strong> is a newest-first
                timeline. Narrow it with the filter bar, or type what you remember into the search
                box — "dog on a beach" works.
              </li>
              <li>
                <strong>Develop.</strong> Open a photo and press <kbd>E</kbd>. Crop, tone, color,
                masks — the original file is never written to, so nothing you do here can go wrong.
              </li>
              <li>
                <strong>Hand them out.</strong> Collect the ones you want in <strong>Selects</strong>
                , then <strong>Export…</strong> — as JPEGs with your edits baked in, or as the
                original files 1:1.
              </li>
            </ol>
            <Tip title="Want a tour instead?">
              <em>Settings → Show me around</em> walks you through every settings section, and you
              can leave at any step and rerun it later.
            </Tip>
          </>
        ),
      },
      {
        id: "appearance",
        title: "Making it look right",
        where: <>Settings → Look &amp; feel</>,
        lead: <>You pick two skins — one light, one dark — and a mode that decides which is showing.</>,
        body: (
          <>
            <p>
              The mode is <strong>Light</strong>, <strong>Dark</strong>, or <strong>Auto</strong>,
              which follows your operating system and switches along with it while the app is open.
            </p>
            <p>Four skins per side, all deliberately quiet so nothing competes with the photos:</p>
            <ul>
              <li>
                <strong>Graphite</strong> — neutral gray, the default.
              </li>
              <li>
                <strong>Slate</strong> — cooler, with a steel-blue accent.
              </li>
              <li>
                <strong>Ink</strong> — high contrast: paper white, or a near-black surround in the
                dark.
              </li>
              <li>
                <strong>Orange</strong> — warm surfaces with a burnt orange accent, amber in the
                dark.
              </li>
            </ul>
            <p>
              Each tile previews its own colors. The choice belongs to the computer, not the
              library, so it survives switching libraries.
            </p>
          </>
        ),
      },
    ],
  },

  // --------------------------------------------------------------- import --
  {
    id: "import",
    label: "Importing",
    blurb: "Three ways in: copy photos from a card, index a folder where it lies, or fold a second Rollfilm library into this one.",
    topics: [
      {
        id: "import-photos",
        title: "From a card or a folder",
        where: <>Import → Import photos ▾ → Choose folder… / Choose files…</>,
        lead: (
          <>
            Photos are copied into a staging area first, reviewed there, and only then added to your
            library — so a card can be culled before anything lands.
          </>
        ),
        body: (
          <>
            <p>
              Supported: JPEG, PNG and RAW (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2, PEF, SRW).
            </p>
            <h4>What happens, in order</h4>
            <ol>
              <li>
                <strong>Copying.</strong> The files are read into staging. You can switch to another
                tab meanwhile — the Import link keeps showing the progress.
              </li>
              <li>
                <strong>Duplicate check.</strong> "Already in library" means byte-identical; those
                can't be imported again. Nothing is flagged for merely looking similar, so a burst
                or a bracketed set comes in complete. "Hide duplicates" (on by default) keeps them
                out of view.
              </li>
              <li>
                <strong>Culling.</strong> Rate and color-label staged photos right away — on the
                cards, or in the preview (<kbd>←</kbd> / <kbd>→</kbd> to flip through,{" "}
                <kbd>0</kbd>–<kbd>5</kbd> for stars, <kbd>Space</kbd> to include or exclude).
              </li>
              <li>
                <strong>Selecting.</strong> Press "Select", then click cards to tick them.{" "}
                <strong>Shift-click</strong> applies that same tick (or untick) to the whole range
                since your last click. The tick box on a <strong>day heading</strong> takes or
                clears that day in one go; if the batch spans several months or years, the heading
                offers those wider scopes too.
              </li>
              <li>
                <strong>Adding.</strong> "Add N photos to library" copies the selection into your
                library folder. "Discard batch" throws the staging session away — at that point
                nothing has entered your library at all.
              </li>
            </ol>
            <h4>Good to know</h4>
            <ul>
              <li>
                <strong>A long copy doesn't have to run to the end.</strong>{" "}
                <em>Stop &amp; keep copied</em> finishes the photos already on their way and hands
                you the review for exactly those. Nothing is thrown away — that is what "Cancel"
                and "Discard batch" are for.
              </li>
              <li>
                <strong>RAW+JPEG pairs</strong> shot together are detected. In merged view they act
                as one photo; if you select only one half, the import asks whether to bring the
                partner along.
              </li>
              <li>
                <strong>A photo that so far only lives in an external source</strong> can still be
                imported. The imported copy becomes the library's own and keeps its stars, tags,
                albums and edits — the file in the external folder stays untouched.
              </li>
              <li>
                <strong>"Also upload to Immich (JPG only)"</strong> pushes the imported JPEGs to
                your Immich server, if you set one up. RAW files never leave this library.
              </li>
            </ul>
          </>
        ),
      },
      {
        id: "external",
        title: "Folders that stay where they are",
        where: <>Import → External photo sources</>,
        lead: (
          <>
            An external source is a folder Rollfilm <strong>indexes in place</strong> — nothing is
            copied or moved. Right for a NAS or an existing archive you don't want reorganized.
          </>
        ),
        body: (
          <ul>
            <li>
              <strong>Scanning</strong> happens at app start and whenever you press "Scan now".
            </li>
            <li>
              <strong>Unplugged drive?</strong> The source shows as <strong>Disconnected</strong>{" "}
              and its photos are hidden until it comes back.
            </li>
            <li>
              <strong>"Remove"</strong> forgets the index only. The files stay exactly where they
              are.
            </li>
            <li>
              <strong>Deleting one of its photos</strong> removes the catalog entry, never the
              file, and it does not go to the Trash — there would be nothing to restore. Automatic
              scans keep it removed; a manual "Scan now" re-indexes the whole folder, including
              photos you removed.
            </li>
            <li>
              <strong>No duplicates with your library.</strong> A scan skips files that are
              byte-identical to a photo you already imported, and importing a photo a source
              already indexed turns that entry into a regular library photo instead of creating a
              second one.
            </li>
          </ul>
        ),
      },
      {
        id: "import-library",
        title: "Another Rollfilm library",
        where: <>Import → Import a library</>,
        lead: (
          <>
            Took a small drive travelling, made a library on it and culled the trip there? This
            folds that library into this one — carrying the work, not just the photos.
          </>
        ),
        body: (
          <>
            <p>
              Importing that drive as a plain folder would bring the photos across but leave behind
              exactly the part the trip was spent on. Instead:
            </p>
            <ul>
              <li>
                <strong>Stars, color labels, tags and every edit come along.</strong> Albums and
                tags merge <strong>by name</strong>, so "Iceland 2026" joins the album you already
                have instead of becoming a second one with the same name. RAW+JPEG pairs stay
                paired.
              </li>
              <li>
                <strong>Photos you already have</strong> (byte for byte) keep their file where it
                is and only take over the ratings and edits you gave them on the trip — the newer
                decision wins.
              </li>
              <li>
                <strong>Nothing here is removed, and the other drive is only ever read.</strong> Its
                Trash stays behind (you threw those away on purpose), as do photos it merely indexes
                in place from somewhere else.
              </li>
              <li>
                <strong>It runs in the background.</strong> Keep browsing, editing, even importing a
                card while it works. It shows how far along it is and roughly how long is left, and
                it can be stopped — a stopped import keeps everything that already came across, and
                running it again picks up where it left off.
              </li>
            </ul>
            <Tip title="Same version on both sides.">
              If the travel library is older, open it once with this version (
              <em>Settings → Library folder</em>) so it can update itself, then merge it.
            </Tip>
          </>
        ),
      },
    ],
  },

  // --------------------------------------------------------------- browse --
  {
    id: "browse",
    label: "Browsing & sorting",
    blurb: "The grid and the filter bar, plus the ways photos end up in groups: marks you give them, albums you make, albums the app makes, and the map.",
    topics: [
      {
        id: "library-grid",
        title: "The library grid",
        where: <>Library</>,
        lead: (
          <>
            A newest-first timeline grouped by month, with the filter bar above it and a{" "}
            <strong>date scrubber</strong> down the right edge — drag it to jump years at a time.
          </>
        ),
        body: (
          <>
            <h4>Narrowing what you see</h4>
            <ul>
              <li>
                <strong>Filters:</strong> album, minimum star rating, color label, tags (a photo
                must carry <em>all</em> the tags you pick), camera, lens, a focal-length range and a
                capture-date range. They <strong>cross-filter</strong> each other: pick a camera and
                the lens and focal-length choices narrow to what that camera actually shot. "Clear"
                resets everything.
              </li>
              <li>
                <strong>File types:</strong> show RAW + JPEG, only JPEGs, or only RAWs. With{" "}
                <strong>Merge RAW+JPG</strong> a pair appears as a single card — rating, labelling
                or deleting it applies to both files.
              </li>
              <li>
                <strong>Thumbnail size</strong> from XS to XL, remembered per computer.
              </li>
            </ul>
            <h4>Working on many photos at once</h4>
            <p>
              Press <strong>Select</strong>, click photos (<kbd>Shift</kbd>-click for a range), and
              the bar at the bottom acts on all of them: set stars or a color label, add a tag, add
              to an album, add to Selects, send to Immich, <strong>Auto develop</strong> the whole
              selection, <strong>apply a saved preset</strong>, delete — or{" "}
              <strong>Reset…</strong> chosen aspects back to the just-imported state (any of stars,
              colors, tags, albums, edits, crop &amp; geometry).
            </p>
          </>
        ),
      },
      {
        id: "search",
        title: "Search",
        where: <>The search box in the top bar</>,
        lead: (
          <>
            Type what is <em>in</em> the picture, not what the file is called — "dog on a beach",
            "red car at night".
          </>
        ),
        body: (
          <p>
            Search matches your tag names first, then ranks photos by how closely the image content
            itself matches your words. It respects where you are: inside an album it searches that
            album, everywhere else the whole library. Photos on a disconnected external source are
            skipped, and an active filter (rating, color, tag, date) narrows the results too — if
            something you know is there doesn't show up, clear the filters first.
          </p>
        ),
      },
      {
        id: "labels",
        title: "Stars, colors and tags",
        lead: <>Three marks you give photos yourself. They are independent, and none of them mean anything until you decide what they mean.</>,
        body: (
          <ul>
            <li>
              <strong>Stars (0–5)</strong> — click the stars on a card, in the photo view or in the
              bulk bar, or press <kbd>0</kbd>–<kbd>5</kbd>. Clicking the same star again clears the
              rating.
            </li>
            <li>
              <strong>Color labels</strong> — red, orange, yellow, green, blue, magenta or gray.
              Use them for whatever workflow suits you (green = done, red = revisit).
            </li>
            <li>
              <strong>Tags</strong> — free-form keywords with autocomplete. Add them to one photo in
              its side panel, or to a whole selection at once. Tags nothing carries anymore can be
              cleaned up under <em>Settings → Library → Tags</em>.
            </li>
          </ul>
        ),
      },
      {
        id: "albums",
        title: "Albums",
        where: <>Albums</>,
        lead: (
          <>
            Albums are the groups you make by hand. A photo can be in as many as you like, and
            taking it out of one — or deleting the album — never deletes the photo.
          </>
        ),
        body: (
          <ul>
            <li>
              <strong>Create</strong> an album with the field at the top of the Albums page. Fill it
              from the bulk bar ("Add to album") or from a photo's side panel.
            </li>
            <li>
              <strong>An album that fills itself:</strong> give it one or more tags when you create
              it, and every photo carrying any of those tags belongs to it automatically — including
              photos you tag later.
            </li>
            <li>
              <strong>Rename</strong> by clicking the name on the album card.
            </li>
          </ul>
        ),
      },
      {
        id: "smart-albums",
        title: "Smart albums",
        where: <>Albums, in the rows above your own · Settings → Library → Smart albums</>,
        lead: (
          <>
            Rows the app builds and keeps up to date by itself, straight from the photos. You never
            fill them, and they cost nothing — they are views, not copies.
          </>
        ),
        body: (
          <>
            <ul>
              <li>
                <strong>Moments</strong> — groups of visually similar photos, found and named
                automatically with broad subjects (Nature, City, People, Sports…). Several moments
                of the same subject stack under one card.
              </li>
              <li>
                <strong>Tags</strong> — one album per tag you have given out.
              </li>
              <li>
                <strong>Places</strong> — photos taken close together, named after the nearest town.
                Needs GPS in the photo.
              </li>
              <li>
                <strong>Countries</strong>, and <strong>Countries by year</strong> ("Italy 2024").
              </li>
              <li>
                <strong>Big days</strong> — single days with unusually many photos: a trip, a party,
                an event.
              </li>
              <li>
                <strong>Years</strong> and <strong>Months</strong>.
              </li>
              <li>
                <strong>Edited</strong> — every photo you have edited, plus the saved edit copies.
              </li>
            </ul>
            <p>
              Switch off any row you don't want under <em>Settings → Library → Smart albums</em>,
              where you also set how wide a "place" is. Moments are worked out in the background —
              the row says so the first time, and after that they follow your imports on their own.
            </p>
          </>
        ),
      },
      {
        id: "map-stats",
        title: "Map and statistics",
        lead: <>Two ways of looking at the library as a whole instead of photo by photo.</>,
        body: (
          <ul>
            <li>
              <strong>Map</strong> (in the nav) shows a pin for every photo whose EXIF carries GPS
              coordinates — phones add these automatically, many cameras don't. A RAW+JPEG pair is
              one pin. Click a pin to open the photo.
            </li>
            <li>
              <strong>Statistics</strong> (the chart icon, top right) counts what you have: photos,
              library size, the years they span, how many are rated, edited or located, photos per
              year, your most-used bodies, lenses and focal ranges, and what kind of files the
              library is made of.
            </li>
          </ul>
        ),
      },
    ],
  },

  // ----------------------------------------------------------------- edit --
  {
    id: "edit",
    label: "Editing",
    blurb: "Looking at one photo closely, developing it, and letting the app propose a development learned from your own past edits.",
    topics: [
      {
        id: "photo-view",
        title: "The photo view",
        where: <>Click any photo</>,
        lead: (
          <>
            The photo big, with everything known about it in a panel beside it — and the keyboard
            for the rest.
          </>
        ),
        body: (
          <>
            <ul>
              <li>
                <strong>Looking closer:</strong> scroll or pinch to zoom toward the cursor, drag to
                pan, double-click to jump between fit and 100%. The zoom control under the photo
                names the current percentage and offers Fit / 100% / 200%.
              </li>
              <li>
                <strong>The side panel</strong> holds the EXIF details (capture date, camera, lens,
                ISO, aperture, shutter, focal length), the photo's tags and albums, a{" "}
                <strong>Similar photos</strong> strip found by visual similarity, and{" "}
                <strong>Export…</strong>. The trash can next to the file name deletes the photo.
              </li>
              <li>
                <strong>Without the mouse:</strong> <kbd>E</kbd> opens the editor, <kbd>P</kbd> hides
                the panel so the photo gets the whole window, <kbd>0</kbd>–<kbd>5</kbd> rate,{" "}
                <kbd>←</kbd> / <kbd>→</kbd> walk the same filtered set you came from, <kbd>↑</kbd> /{" "}
                <kbd>↓</kbd> switch between the RAW and the JPEG of a pair, and <kbd>Esc</kbd> goes
                back — first out of the zoom, then out of the photo.
              </li>
              <li>
                <strong>Slideshow:</strong> the toolbar's <strong>Slideshow</strong> button (or{" "}
                <kbd>S</kbd>) plays the set you're browsing fullscreen, advancing automatically and
                wrapping around at the end. <kbd>Space</kbd> pauses, <kbd>←</kbd> / <kbd>→</kbd> step
                by hand, the control bar picks the pace (3, 5 or 10 seconds per photo), and{" "}
                <kbd>Esc</kbd> ends the show on the photo it reached.
              </li>
            </ul>
          </>
        ),
      },
      {
        id: "editor",
        title: "The editor",
        where: <>Photo view → Edit, or press <kbd>E</kbd></>,
        lead: (
          <>
            Every adjustment is <strong>non-destructive</strong>: the original file is never written
            to, and the preview you see is rendered by exactly the pipeline that saves.
          </>
        ),
        body: (
          <>
            <p>
              The panel is nine sections, opened one at a time — <kbd>1</kbd>–<kbd>9</kbd> jump
              straight to one. The histogram stays visible above them all, whichever section is
              open.
            </p>
            <h4>1 · Transform — the frame</h4>
            <p>
              Opening it puts the crop box on the photo: drag it freeform or locked to a ratio
              (Original, 1:1, 3:2, 4:3, 5:4, 7:5, 16:9 and their portrait counterparts), then{" "}
              <em>Apply</em>. Applying cuts the picture down there and then, so everything after it
              is judged on the cropped photo; the crop button reopens the box on the full frame when
              you want to re-frame. Also here: rotation in 90° steps, flips, straighten, horizontal
              and vertical tilt, lens distortion, a <strong>white frame</strong> (a matte border
              that saves and exports like any other adjustment), and composition overlays — rule of
              thirds, grid, diagonals.
            </p>
            <h4>2 · Film Simulation — the starting point</h4>
            <p>
              Built-in Fuji-style looks (Provia, Velvia, Astia, Classic Chrome, Classic Neg.,
              Nostalgic Neg., Eterna, Acros and its yellow/red filters, Monochrome) with a strength
              slider. The look becomes the base your other adjustments build on, so it is worth
              choosing before you start pushing sliders.
            </p>
            <h4>3 · Tone — the light</h4>
            <p>
              Exposure, brightness, contrast, highlights, shadows, whites and blacks — over a
              choice of tone curve. <strong>Basic</strong> is the straightforward one;{" "}
              <strong>AgX</strong> is filmic: it rolls the highlights off more softly and lets
              bright, saturated areas fade toward white instead of shifting color, which is what
              you want for skies and hard sunlight.
            </p>
            <h4>4 · Curves</h4>
            <p>
              A point curve per channel (luma, red, green, blue), drawn over that channel's own
              histogram, or the parametric region sliders. Click to add a point and drag it in one
              go, <kbd>Shift</kbd>-drag to hold its input value, arrow keys to nudge, double-click
              to remove. The target button aims the curve at the photo: point at a tone, drag up or
              down, and the point for exactly that tone moves with you.
            </p>
            <h4>5 · Color</h4>
            <p>
              Temperature, tint, vibrance, saturation, hue, and the Fuji Color Chrome / Chrome Blue
              extras. Below them three more tools:
            </p>
            <ul>
              <li>
                <strong>Color mixer</strong> — hue, saturation and luminance per color band (red,
                orange, yellow, green, aqua, blue, purple, magenta), plus <strong>Range</strong>:
                how far that band's edit carries into the neighboring colors before the next band
                takes over. Turn it down to keep a change tight around one color, up to let it wash
                across the ones beside it.
              </li>
              <li>
                <strong>Color grading</strong> — a wheel each for shadows, midtones, highlights and
                the whole image, with blending and balance between them.
              </li>
              <li>
                <strong>Calibration</strong> — hue and saturation of the red, green and blue
                primaries, plus shadow tint. The deep end: it changes how every color is built.
              </li>
            </ul>
            <h4>6 · Details</h4>
            <p>
              Sharpness and its threshold, clarity, dehaze, luminance and color noise reduction,
              and chromatic aberration correction (red–cyan, blue–yellow).
            </p>
            <h4>7 · Effects</h4>
            <p>
              Glow, halation, light flares, grain (amount, size, roughness), vignette (amount,
              midpoint, roundness, feather) and mist.
            </p>
            <h4>8 · Masks — editing part of the photo</h4>
            <p>
              Radial, linear, brush, luminance, color and edge masks, each with its own set of
              sliders. Any of them can be <strong>limited to an area</strong>: add a radial,
              linear or brush shape to a mask and it applies only where the two overlap (or, with
              Outside, only where they don't). That is what makes the selections with no place of
              their own usable — an <strong>edge</strong>
              mask selects where the picture has detail instead of where it is bright — the one
              to put sharpness or clarity on, since it catches hair, branches and fabric while
              leaving skin and sky alone (a luminance mask cannot tell those apart: it only knows
              how dark they are) — but it finds every edge in the frame, so limit it to the part of
              the picture you meant. <strong>Select subject</strong> finds
              a region for you — sky, water, greenery, people, buildings or ground — and drops it in
              as a mask you can then refine like any other. The first subject on a photo takes a few
              seconds (the detection model downloads itself once, on first use); any further one on
              the same photo is instant. Change the crop or straighten afterwards and the mask says
              so, with a button to find it again in the new frame. Point at a mask in the list to
              see what it covers, marked in pink; it steps out of the way as soon as you point
              elsewhere. <strong>Show mask</strong> keeps that marking up while you work, which is
              how a luminance, color or edge mask is set — those have no shape on the photo, so the
              marking is the only way to see what they select as you drag their sliders. It also
              happens by itself: move a slider that decides what a mask selects — a threshold, a
              feather, a tolerance — and the mask is marked while you work, clearing again a moment
              after you stop.
            </p>
            <h4>9 · Presets</h4>
            <p>
              Save the current look under a name and reapply it to other photos (crop and rotation
              are not part of a preset — they belong to one picture). A saved preset can also be
              applied to a whole selection at once from the Library's bulk bar.
            </p>
            <h4>Handy while you work</h4>
            <ul>
              <li>
                <strong>Double-click a slider</strong> to reset just that one.
              </li>
              <li>
                <strong>Hold "Compare"</strong> to peek at the original, or put it side by side.
              </li>
              <li>
                <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> undo and redo. One slider drag or brush stroke is one
                step, so undo walks back the way you worked.
              </li>
              <li>
                <kbd>↑</kbd> / <kbd>↓</kbd> step through the open section's sliders, <kbd>←</kbd> /{" "}
                <kbd>→</kbd> change the focused one.
              </li>
              <li>
                <strong>Background:</strong> switch between a light and a dark surround behind the
                photo — some pictures only tell you the truth on one of them.
              </li>
            </ul>
            <h4>Finishing</h4>
            <ul>
              <li>
                <strong>Save</strong> updates this photo's edit. Nothing else changes; the file
                stays as it was.
              </li>
              <li>
                <strong>Save copy</strong> makes a new photo and leaves the original untouched. It
                asks which kind: a physical copy (a new JPEG with the edits baked in, tagged "edit
                copy") or a virtual copy (no new file - a second entry sharing the original's file
                with its own edits, tagged "virtual copy"). Turn on{" "}
                <em>Settings → Photos → Photo editor</em> if you would also like to pick quality
                and size for physical copies.
              </li>
              <li>
                <strong>Reset all</strong> clears every adjustment and gives you the photo as it was
                imported.
              </li>
              <li>
                <strong>For the best quality</strong>, export the edited original rather than a
                saved copy — a copy is already a JPEG, and exporting it compresses it a second time.
              </li>
            </ul>
          </>
        ),
      },
      {
        id: "auto-develop",
        title: "Auto develop",
        where: <>Settings → Photos → Auto develop</>,
        lead: (
          <>
            A suggested development, <strong>learned from your own editing</strong> — no cloud, no
            generic "AI look". It stays off until you switch it on.
          </>
        ),
        body: (
          <>
            <h4>How it learns</h4>
            <ul>
              <li>
                Every photo you have edited — saved in place or saved as a copy — becomes an
                example. Asked for a suggestion, it finds the examples that look most{" "}
                <strong>visually similar</strong> to the photo in front of you and blends the
                settings you chose for them, weighting the closest matches most. It therefore works
                from a single edited photo, and gets better the more you edit.
              </li>
              <li>
                RAW and JPEG learn from their own kind where possible — a RAW is developed from
                flat, a camera JPEG only fine-tuned — and it never learns from the photo you are
                editing or from its RAW+JPEG partner.
              </li>
              <li>
                It suggests sliders and color settings, never <strong>crop, rotation or masks</strong>
                : those belong to one specific photo and don't transfer.
              </li>
            </ul>
            <h4>Using it</h4>
            <ul>
              <li>
                <strong>In the editor</strong> an <strong>Auto</strong> button appears in the
                footer. It only fills the sliders with a suggestion — nothing reaches your photo
                until you <em>Save</em> — so you can push it further, or reset and try again. Masks
                you have drawn are kept.
              </li>
              <li>
                <strong>On a selection:</strong> pick photos in the Library and press{" "}
                <strong>Auto develop</strong> in the bulk bar to develop each one with its own
                suggestion. This one <em>does</em> change the photos, so it asks first if any of
                them already have edits. Photos with nothing similar to learn from yet are skipped
                and counted.
              </li>
              <li>
                <strong>What it may touch:</strong> in Settings you can limit it to certain groups —
                Tone, White balance, Color, Details, Curves, Effects. Unchecked groups keep
                whatever the sliders currently hold, so it can handle the tone while you set the
                rest yourself.
              </li>
            </ul>
          </>
        ),
      },
    ],
  },

  // ---------------------------------------------------------------- share --
  {
    id: "share",
    label: "Getting photos out",
    blurb: "Collect the ones that are finished, then export them as files or push them to an Immich server.",
    topics: [
      {
        id: "selects",
        title: "Selects — your shortlist",
        where: <>Selects (the nav shows a live count)</>,
        lead: (
          <>
            A tray, not an album: while you browse, drop in the shots you want to hand out, then
            deal with all of them in one go.
          </>
        ),
        body: (
          <>
            <p>
              Add photos from the Library's bulk bar ("Add to Selects"), from inside an album, or on
              a photo's own page. Nothing about the photos changes by being in there.
            </p>
            <ul>
              <li>
                <strong>Review the set.</strong> Click photos to select them (shift-click for a
                range) — or leave nothing selected and the actions apply to the whole list.
              </li>
              <li>
                <strong>Export…</strong> gets them out; see the next topic.
              </li>
              <li>
                <strong>Add to Immich</strong> uploads the set's JPEGs to your server (shown only
                when the integration is configured; RAW files are skipped).
              </li>
              <li>
                <strong>Remove from selects</strong> empties the tray again. The photos themselves
                stay untouched in your library.
              </li>
            </ul>
          </>
        ),
      },
      {
        id: "export",
        title: "Export",
        where: <>Photo view → Export… · Selects → Export…</>,
        lead: <>Two kinds of file, depending on who is getting it.</>,
        body: (
          <>
            <ul>
              <li>
                <strong>JPEG — edits baked in.</strong> Rendered fresh from the original at a
                quality and size you choose (original size, 4K, 2048 px or 1024 px). This is what
                you send people.
              </li>
              <li>
                <strong>Original files — 1:1.</strong> Exactly what is in your library, RAW stays
                RAW, every metadata tag kept. This is what you give another editor, or an archive.
              </li>
            </ul>
            <p>Several photos at once come down as a zip.</p>
          </>
        ),
      },
      {
        id: "immich",
        title: "Immich",
        where: <>Settings → Integrations → Immich integration</>,
        lead: (
          <>
            Mirrors part or all of your library to an{" "}
            <a href="https://immich.app" target="_blank" rel="noreferrer">
              Immich
            </a>{" "}
            server — to see your photos on your phone, or share them with family. Only JPEGs are
            ever uploaded; RAW files always stay local.
          </>
        ),
        body: (
          <>
            <h4>Setting it up</h4>
            <ol>
              <li>
                <strong>Server address:</strong> the URL you use to open Immich in the browser, e.g.{" "}
                <code>https://immich.example.com</code> or <code>http://192.168.1.50:2283</code>.
              </li>
              <li>
                <strong>API key:</strong> in Immich (not here), click your avatar →{" "}
                <em>Account Settings → API Keys → New API Key</em>. The key is shown{" "}
                <strong>only once</strong> — copy it straight into the API key field here.
              </li>
              <li>
                <strong>Test connection</strong> confirms address and key. It should greet you with
                your Immich account name.
              </li>
            </ol>
            <h4>How much gets mirrored</h4>
            <ul>
              <li>
                <strong>Manual</strong> (default) — nothing happens by itself. You push photos:
                the "Also upload to Immich" tick during import, or "Add to Immich" on a selection.
              </li>
              <li>
                <strong>Selective</strong> — you mark what should live on Immich with the "Sync to
                Immich" tick on a selection or on an album. Marked photos upload and stay in sync.
              </li>
              <li>
                <strong>Full</strong> — every JPEG and every album is mirrored automatically.
              </li>
            </ul>
            <h4>What "in sync" means</h4>
            <p>
              In selective and full mode, Immich mirrors what is visible in your library. A check
              runs at app start and once a minute, so changes follow within about a minute even if
              Immich was briefly unreachable:
            </p>
            <ul>
              <li>New or restored photos are uploaded; photos you put in the Trash are removed from
                Immich.</li>
              <li>
                <strong>"Delete forever"</strong> removes the photo from Immich permanently, too.
              </li>
              <li>
                Mirrored albums follow along — adding and removing photos, renaming, deleting.
                Deleting an album never deletes photos, on either side.
              </li>
              <li>
                Unticking "Sync to Immich" only <em>stops</em> syncing; photos already there stay.
                Removing happens exclusively via the Trash.
              </li>
            </ul>
            <h4>Which API key permissions are needed?</h4>
            <p>
              Newer Immich versions let you restrict a key when creating it. Choosing{" "}
              <strong>"All"</strong> simply works. For a minimal key:
            </p>
            <ul>
              <li>
                <strong>Assets:</strong> <code>asset.upload</code> (send photos, and recognize ones
                Immich already has), <code>asset.delete</code>
              </li>
              <li>
                <strong>Albums:</strong> <code>album.create</code>, <code>album.read</code>,{" "}
                <code>album.update</code>, <code>album.delete</code>, plus{" "}
                <code>albumAsset.create</code> / <code>albumAsset.delete</code>
              </li>
              <li>
                <strong>User:</strong> <code>user.read</code> (used by "Test connection")
              </li>
            </ul>
            <p>
              Older versions don't ask — their keys always have full access. If something fails with
              a permission error, recreate the key with "All".
            </p>
            <Tip title="Did it arrive?">
              Every upload and removal is listed with a ✓ or the exact error under{" "}
              <em>Settings → Immich → Recent uploads</em>. Network hiccups are retried
              automatically, and "duplicate" means Immich already has that photo — that is fine, not
              an error.
            </Tip>
          </>
        ),
      },
    ],
  },

  // --------------------------------------------------------------- safety --
  {
    id: "safety",
    label: "Trash & backup",
    blurb: "What happens when you delete something, and how to get a whole library back.",
    topics: [
      {
        id: "trash",
        title: "Deleting and the Trash",
        where: <>Trash</>,
        lead: <>What "Delete" does depends on where the photo lives.</>,
        body: (
          <>
            <ul>
              <li>
                <strong>Photos you imported</strong> move to the <strong>Trash</strong>. The file
                stays in your library folder and the photo keeps its stars, tags, albums and edits,
                so <strong>Restore</strong> brings it back exactly as it was.
              </li>
              <li>
                <strong>Photos from an external source</strong> are removed from the catalog
                immediately and don't appear in the Trash — because{" "}
                <strong>their files are never deleted</strong>, there is nothing to restore. The
                original stays in your folder or on your NAS, and automatic scans won't bring the
                entry back; press <em>Scan now</em> on the source (or import the file) if you want
                it again.
              </li>
            </ul>
            <h4>Half a pair</h4>
            <p>
              Delete only the JPEG of a RAW+JPEG shot and the pair is <strong>suspended</strong> for
              as long as one half is in the Trash: the deleted file is gone from the library right
              away, and the half left behind stops standing in for it — it shows as the single RAW
              it now is. In the Trash the entry is badged for what is actually in there, not for the
              shot it came from. Restore, and the two are a pair again with nothing to redo. A pair
              is deleted together by default; turn on{" "}
              <em>Settings → Library → Trash → "Ask what to delete for RAW + JPEG pairs"</em> to be
              offered "only this file" instead.
            </p>
            <h4>Emptying it</h4>
            <p>
              <strong>"Delete forever"</strong> on the Trash page is the only step that removes
              original files from your library folder, and it cannot be undone — the confirmation
              always spells out what will happen to your selection. The Trash also empties itself:
              at every app start, photos that have been in there longer than the retention period
              (default <strong>14 days</strong>) are deleted for good in the background. Change or
              disable that under <em>Settings → Library → Trash</em> — 0 keeps deleted photos
              forever.
            </p>
          </>
        ),
      },
      {
        id: "backup",
        title: "Backup, restore and repair",
        where: <>Settings → Maintenance</>,
        lead: <>Four buttons, from "keep a copy" to "something is wrong, fix it".</>,
        body: (
          <ul>
            <li>
              <strong>Download backup</strong> — one zip with every photo plus all ratings, colors,
              albums, tags and edits.
            </li>
            <li>
              <strong>Restore from backup</strong> — replaces <em>everything</em> in the current
              library with the backup's contents. You have to type "delete" to confirm.
            </li>
            <li>
              <strong>Sync database to library</strong> — the one-stop repair. Removes entries whose
              files vanished from disk, deletes thumbnails belonging to no photo, regenerates
              missing thumbnails in the background, and reports files sitting in the library folder
              that were never imported.
            </li>
            <li>
              <strong>Rebuild all thumbnails</strong> — the emergency reset: regenerates every
              thumbnail and preview from the originals. Slow, and only needed if thumbnails still
              look wrong after a sync.
            </li>
          </ul>
        ),
      },
    ],
  },

  // ------------------------------------------------------------ reference --
  {
    id: "reference",
    label: "Shortcuts & fixes",
    blurb: "The keys worth learning, and what to do when the app says something unexpected.",
    topics: [
      {
        id: "shortcuts",
        title: "Keyboard shortcuts",
        lead: <>Culling is a keyboard job — these are the keys that make it one.</>,
        body: (
          <table className="help-shortcuts">
            <thead>
              <tr>
                <th>Where</th>
                <th>Key</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>←</kbd> / <kbd>→</kbd>
                </td>
                <td>Previous / next photo (walks the same filtered set you came from)</td>
              </tr>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>↑</kbd> / <kbd>↓</kbd>
                </td>
                <td>Switch between the RAW and the JPEG half of a pair</td>
              </tr>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>0</kbd>–<kbd>5</kbd>
                </td>
                <td>Set the star rating (0 clears it)</td>
              </tr>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>E</kbd>
                </td>
                <td>Open the editor on this photo</td>
              </tr>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>P</kbd>
                </td>
                <td>Show / hide the side panel, so the photo gets the whole window</td>
              </tr>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>S</kbd>
                </td>
                <td>
                  Start a fullscreen slideshow of the set you're browsing (Space pauses, Esc ends
                  it)
                </td>
              </tr>
              <tr>
                <td>Photo view</td>
                <td>
                  <kbd>Esc</kbd>
                </td>
                <td>Zoomed in: back to fit. Otherwise: back to the grid</td>
              </tr>
              <tr>
                <td>Editor</td>
                <td>
                  <kbd>1</kbd>–<kbd>9</kbd>
                </td>
                <td>
                  Open a section: 1 Transform, 2 Film Simulation, 3 Tone, 4 Curves, 5 Color,
                  6 Details, 7 Effects, 8 Masks, 9 Presets
                </td>
              </tr>
              <tr>
                <td>Editor</td>
                <td>
                  <kbd>↑</kbd> / <kbd>↓</kbd>
                </td>
                <td>Step through the sliders of the open section</td>
              </tr>
              <tr>
                <td>Editor</td>
                <td>
                  <kbd>←</kbd> / <kbd>→</kbd>
                </td>
                <td>Adjust the focused slider's value</td>
              </tr>
              <tr>
                <td>Editor</td>
                <td>
                  <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>
                </td>
                <td>Undo / redo (one slider drag or brush stroke is one step)</td>
              </tr>
              <tr>
                <td>Editor</td>
                <td>
                  <kbd>Esc</kbd>
                </td>
                <td>Close the Transform section and its crop box, or close the editor</td>
              </tr>
              <tr>
                <td>Import preview</td>
                <td>
                  <kbd>←</kbd> / <kbd>→</kbd> / <kbd>Esc</kbd>
                </td>
                <td>Previous / next staged file, close the preview</td>
              </tr>
              <tr>
                <td>Import preview</td>
                <td>
                  <kbd>0</kbd>–<kbd>5</kbd>
                </td>
                <td>Set the star rating (0 clears it)</td>
              </tr>
              <tr>
                <td>Import preview</td>
                <td>
                  <kbd>Space</kbd>
                </td>
                <td>Include / exclude this file from the import</td>
              </tr>
              <tr>
                <td>Any grid</td>
                <td>
                  <kbd>Shift</kbd> + click
                </td>
                <td>Select a range of photos (in select mode)</td>
              </tr>
            </tbody>
          </table>
        ),
      },
      {
        id: "troubleshooting",
        title: "When something looks wrong",
        lead: <>The handful of messages people actually run into, and what each one means.</>,
        body: (
          <>
            <h4>Quitting says Rollfilm is "still working"</h4>
            <p>
              Some work outlives the screen that started it: uploads to Immich, thumbnails an import
              couldn't hand over ready-made, the search index catching up, a library being merged
              in. Quitting mid-way is safe — your photos and edits are already saved, and everything
              except queued Immich uploads in manual mode is picked up again on the next start.{" "}
              <strong>"Finish in background"</strong> closes the window and quits by itself once
              it's done; <strong>"Quit now"</strong> stops the rest.
            </p>
            <h4>The app takes very long to start, or says "Backend is taking a while"</h4>
            <p>
              The <strong>first launch</strong> after installing can take several minutes: the
              operating system verifies the app and the image engine loads for the first time.
              Choose <strong>"Keep waiting"</strong> — later launches are much faster.
            </p>
            <h4>"Backend did not start" / "stopped unexpectedly"</h4>
            <p>
              The backend writes a log you can check (the error dialog has an "Open log folder"
              button):
            </p>
            <ul>
              <li>
                macOS: <code>~/Library/Application Support/Rollfilm/logs/backend.log</code>
              </li>
              <li>
                Windows: <code>%APPDATA%\Rollfilm\logs\backend.log</code>
              </li>
              <li>
                Linux: <code>~/.config/Rollfilm/logs/backend.log</code>
              </li>
            </ul>
            <h4>"Your photo library folder can't be found" at startup</h4>
            <p>
              Your library lives on a drive that isn't connected. Reconnect it and the app carries
              on normally — or pick a new location (existing photos are not moved automatically).
            </p>
            <h4>Photos from an external source are missing</h4>
            <p>
              Check <em>Import → External photo sources</em>: a "Disconnected" source means its
              drive or network share is offline. Its photos reappear as soon as it is back.
            </p>
            <h4>An Immich upload didn't arrive</h4>
            <p>
              <em>Settings → Immich → Recent uploads</em> lists every background upload with a ✓ or
              the exact error. If uploads keep failing, use "Test connection" in the same section
              and make sure the server is reachable from this machine.
            </p>
            <h4>Search doesn't find a photo I know is there</h4>
            <p>
              Search covers the current scope only (the album you are in) and skips disconnected
              external sources. Check the filter bar too — an active rating, color, tag or date
              filter narrows search results as well.
            </p>
            <h4>Thumbnails look wrong or outdated</h4>
            <p>
              <em>Settings → Maintenance → Sync database to library</em> first; if they are still
              wrong, <em>Rebuild all thumbnails</em>.
            </p>
            <Tip title="Still stuck?">
              The envelope icon in the top right writes an email with your version number already
              filled in. A problem or an idea is equally welcome.
            </Tip>
          </>
        ),
      },
    ],
  },
];

export function Help() {
  const [activeId, setActiveId] = useState(CHAPTERS[0].id);
  const pageRef = useRef<HTMLDivElement>(null);
  const chapter = CHAPTERS.find((c) => c.id === activeId) ?? CHAPTERS[0];

  // Plain anchors would fight the HashRouter (#/help vs #basics), so the topic
  // links scroll programmatically instead.
  function jumpTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // A new chapter starts at its own beginning - landing halfway down it because
  // the previous one was longer reads as a broken page.
  function openChapter(id: string) {
    setActiveId(id);
    pageRef.current?.scrollTo({ top: 0 });
  }

  return (
    <div className="page help-page" ref={pageRef}>
      <div className="help-inner">
        <h2 className="section-title">Help</h2>
        <p className="help-sub">
          Everything Rollfilm can do, in the order you'll meet it. Seven chapters — pick one.
        </p>

        <nav className="help-tabs" role="tablist" aria-label="Help chapters">
          {CHAPTERS.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={activeId === c.id}
              className={`help-tab${activeId === c.id ? " active" : ""}`}
              onClick={() => openChapter(c.id)}
            >
              {c.label}
            </button>
          ))}
        </nav>

        <p className="help-blurb">{chapter.blurb}</p>

        {/* Jump list for the chapter, so a five-topic chapter can still be
            navigated without scrolling through it. */}
        {chapter.topics.length > 1 && (
          <nav className="help-jump" aria-label={`${chapter.label} topics`}>
            {chapter.topics.map((t) => (
              <button key={t.id} className="help-jump-link" onClick={() => jumpTo(t.id)}>
                {t.title}
              </button>
            ))}
          </nav>
        )}

        {chapter.topics.map((t) => (
          <section key={t.id} className="help-topic">
            <h3 id={t.id} className="help-heading">
              {t.title}
            </h3>
            {t.where && <Where>{t.where}</Where>}
            <p className="help-lead">{t.lead}</p>
            {t.body}
          </section>
        ))}
      </div>
    </div>
  );
}
