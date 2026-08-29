---
name: wcag-perceivable-media
description: Judging whether prerecorded audio and video carry equivalent alternatives under 1.2.1 Audio-only and Video-only, 1.2.2 Captions, 1.2.3 Audio Description or Media Alternative and 1.2.5 Audio Description - load when auditing video players, embedded audio, caption tracks, transcripts or described versions, and note that every finding in this lane is a FLAG for human sign-off.
---

# Audio and video equivalents

**Every finding in this lane carries verdict FLAG, on every finding, however
confident you are.** The response schema accepts no other value, so a DECIDE is
not a stricter judgement - it is a rejected response and a wasted pass. Media
equivalence is a judgement about whether a substitute conveys the same
information to somebody who cannot hear or cannot see, and that judgement
belongs to a person. This output goes to a human sign-off queue and is never
sent to the FIX agent.

That does not lower the standard of your evidence, it raises it. The person
signing off has not watched the video. They have your timestamps and your
quotations and nothing else.

Lane: MEDIA.

---

## 1.2.1 Audio-only and Video-only (Prerecorded) - Level A

### What the standard requires

Two cases, two remedies:

| Content | Required alternative |
|---|---|
| Prerecorded audio-only - a podcast, an interview, a recorded call | A text transcript conveying the same information |
| Prerecorded video-only - a silent screen recording, a soundless loop, an animation with no audio | **Either** a text transcript **or** an audio track describing what is shown |

The alternative must be labelled and discoverable from the media itself.

### How to test it

1. Classify each asset. Audio-only, video-only, or video with audio. Video with
   audio belongs to 1.2.2, 1.2.3 and 1.2.5, not here.
2. Play or read the asset end to end and write down the information it carries -
   facts, figures, names, instructions, outcomes, on-screen text.
3. Find the alternative on the page or linked from it and read it end to end.
4. Compare item by item and name what is missing.
5. Check discoverability. A link next to the player or a disclosure below it
   counts; a file on the server that nothing links to does not.

### Genuine failure

- A 24-minute recorded webinar with no transcript anywhere on the page.
- A transcript reading "Audio recording about housing benefit" for a four-minute
  explanation of eligibility rules.
- A silent screen recording showing how to complete a form, with no transcript
  and no described audio - a blind user gets nothing at all.
- A transcript covering only the first speaker of a three-speaker panel.
- A transcript omitting the figures read aloud in the recording.

### False positive - do not report

- **A transcript on a separate linked page.** Acceptable when it is discoverable
  and linked from the media; it does not have to be inline.
- **Decorative background video with no audio and no information** - an abstract
  loop behind a hero heading. Nothing is conveyed, so nothing is owed.
- A transcript that paraphrases rather than transcribing verbatim, where every
  piece of information survives. Equivalence is the test, not stenography.
- An audio file that is itself an alternative to on-page text and is labelled so.
- A video-only asset with a described audio track but no transcript. Either one
  satisfies 1.2.1.

---

## 1.2.2 Captions (Prerecorded) - Level A

### What the standard requires

Captions for all prerecorded audio content in synchronised media. Captions are
not a transcript: they are time-synchronised, they identify who is speaking, and
they label significant non-speech sound. Judge accuracy against what is actually
said, then speaker identification, then significant non-speech sound.

### How to test it

1. Confirm a caption track exists and is selectable, or that captions are burned
   into the picture.
2. Play with captions on and follow the audio against the caption text. Do not
   read the caption file alone - the failures live in the mismatch.
3. Log every divergence with its timestamp: dropped passages, wrong words that
   change meaning, misheard numbers and names, captions lagging or running ahead.
4. Where more than one person speaks, check that lines are attributed.
5. Check significant non-speech sound - an alarm, a phone, laughter, music that
   carries meaning. Sound carrying no information needs no caption.
6. Weigh each divergence by consequence. A misheard filler word is noise; a
   misheard eligibility rule, deadline or amount is serious.

### Genuine failure

- A video with no caption track and no burned-in captions.
- At 01:12 the speaker says "you may qualify" and the caption reads "you will
  qualify" - the caption states a guarantee the speaker did not give.
- Captions that stop 90 seconds into a six-minute video.
- A caption track in the wrong language, or auto-translated into gibberish.
- A three-person panel captioned as one undifferentiated stream.
- A fire alarm through a safety demonstration with no `[alarm sounding]` caption.
- An amount read as "sixteen thousand" captioned as "sixty thousand".

### False positive - do not report

- **Open captions burned into the video. They are still captions.** Report them
  only when inaccurate, never for being non-selectable.
- **Auto-generated captions that are merely imperfect** - punctuation slips, a
  missed filler word, an inconsistent brand name. Worth noting at low severity.
  A garbled eligibility rule, deadline or amount is a different matter and is
  serious.
- Captions that condense verbatim speech while preserving meaning.
- Missing captions for background music carrying no information.
- A caption style you find hard to read. Presentation belongs to other lanes.
- A transcript offered as well as captions. Extra provision is not a failure.

---

## 1.2.3 Audio Description or Media Alternative (Prerecorded) - Level A

### What the standard requires

For prerecorded synchronised media, **either** an audio description of the video
content **or** a full text media alternative. Level A gives the author the
choice. A media alternative is a text document carrying everything the media
conveys - dialogue and visual information both, in order.

### How to test it

1. Watch with the sound off and note every piece of information carried only by
   the picture: on-screen text and figures, a form being filled, a diagram, a
   demonstrated action, who is doing what to whom.
2. Check whether either remedy exists - a described audio track, or a
   discoverable, linked text media alternative.
3. If a media alternative exists, verify it carries the visual information from
   step 1 and not just the dialogue.
4. If a described track exists, play it and confirm the descriptions land in the
   gaps and cover the visual information.
5. Name precisely which visual information is lost. That list is the finding.

### Genuine failure

- A tutorial where the presenter says "enter it here" while pointing at a field,
  with no description and a dialogue-only transcript.
- On-screen figures shown but never spoken, absent from every alternative.
- A demonstration whose steps are performed silently on screen.
- A closing frame carrying the deadline and phone number, mentioned nowhere in
  the audio or the alternative.

### False positive - do not report

- A transcript that also carries the visual information. That is a valid media
  alternative and satisfies 1.2.3 - though it does **not** satisfy 1.2.5, which
  is a separate finding.
- A video whose narration already describes everything shown - a talking head
  with no visual information beyond the speaker.
- Decorative b-roll behind narration that adds nothing.
- A described version offered as a separate linked video.

---

## 1.2.5 Audio Description (Prerecorded) - Level AA

### What the standard requires

An audio description for all prerecorded video content in synchronised media. At
AA the choice offered at 1.2.3 disappears: a text alternative no longer
satisfies it. **A page can pass 1.2.3 with a transcript and still fail 1.2.5.**
Where that is the situation, report the 1.2.5 finding and not a 1.2.3 one.

### How to test it

1. Reuse the list of visually conveyed information from 1.2.3.
2. Look specifically for a described audio track - a second track in the player,
   a described version linked separately, or descriptions already fitted into
   the original narration.
3. Play the described track and confirm it covers the visual information and
   fits the natural pauses.
4. Where the only remedy is a text alternative, that is a 1.2.5 failure even
   though 1.2.3 is satisfied. Say exactly that in `detail` so the reviewer does
   not read it as a duplicate.

### Genuine failure

- A video with a complete text transcript covering the visuals and no described
  audio track anywhere - passes 1.2.3, fails 1.2.5.
- A player offering only captions and a transcript, with no audio-description
  toggle and no linked described version.
- A described track covering the first minute only.
- A described version linked but returning a 404.
- Descriptions talking over the dialogue rather than filling the gaps.

### False positive - do not report

- Integrated description - narration that already speaks the on-screen
  information as it appears. No separate track is required.
- A video with no visual information beyond a speaker's face.
- A described version on a separate page, discoverable and linked.
- Decorative or silent background video carrying no information.
- Audio-only content. There is no video to describe; that is 1.2.1.

---

## 1.2.4 Captions (Live) is BLOCKED for this product

Never report 1.2.4 and never claim the page passes it. A live stream that is not
running cannot be audited, so the harness classes the criterion as BLOCKED and it
is not in this lane's criterion list - a 1.2.4 finding is rejected by the
response schema and the pass is wasted.

If the page carries a live-stream player, judge only the prerecorded assets you
were given. A recording of a past live event is prerecorded media and is judged
under 1.2.2 like anything else.

---

## Reporting rules for this group

- **Verdict is always FLAG.** Every finding, every criterion, every level of
  confidence. The schema accepts nothing else.
- One finding per media asset per criterion. A video with no captions, no
  description and no transcript produces three findings - 1.2.2, 1.2.3 and
  1.2.5 - not one complaint about the video. Four such videos produce twelve.
- Evidence is timestamped and quoted. "Captions are inaccurate" is unusable to
  the person signing it off. "At 01:12 the speaker says 'you may qualify' and the
  caption reads 'you will qualify'" can be checked in ten seconds. Give the
  timestamp, the words spoken and the words shown.
- Severity is about the consequence of the mistake, not its frequency. A garbled
  eligibility rule, deadline, amount, dosage or safety instruction is `critical`
  or `serious` even when it is the only error in the file. An entirely
  uncaptioned video in the main task flow is `critical`. Cosmetic auto-caption
  imperfections in a marketing video are `minor`.
- Never describe media you did not play or read. If an asset would not load, sat
  behind authentication, or used a player you could not drive, say so in `detail`
  and report only what you observed. Never infer that captions are absent because
  you could not find the control.
- Never invent a selector, a URL, a timestamp or a quotation. A fabricated
  timestamp destroys the reviewer's trust in the whole queue.
