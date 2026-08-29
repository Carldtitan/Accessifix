---
name: wcag-perceivable-media
description: Judging whether prerecorded audio and video carry equivalent alternatives under 1.2.1 Audio-only and Video-only, 1.2.2 Captions, 1.2.3 Audio Description or Media Alternative and 1.2.5 Audio Description - load when auditing video players, embedded audio, caption tracks, transcripts or described versions, and note that every finding in this lane is a FLAG for human sign-off.
---

# Audio and video equivalents

**Every finding in this lane carries verdict FLAG. On every finding, however
confident you are.** The response schema for this lane accepts no other value,
so a DECIDE is not a stricter judgement - it is a rejected response and a wasted
pass. Media equivalence is a judgement about whether a substitute conveys the
same information to somebody who cannot hear, or cannot see, and that judgement
belongs to a person. Your output goes to a human sign-off queue and is never
sent to the FIX agent.

That does not lower the standard of your evidence. It raises it. The person
signing off has not watched the video; they have your timestamps and your
quotations and nothing else.

Lane: MEDIA.

---

## 1.2.1 Audio-only and Video-only (Prerecorded) - Level A

### What the standard requires

Two different cases with two different remedies:

| Content | Required alternative |
|---|---|
| Prerecorded audio-only - a podcast, an interview, a recorded call, an audio announcement | A text transcript conveying the same information |
| Prerecorded video-only - a silent screen recording, a soundless product loop, an animated explainer with no audio | **Either** a text transcript **or** an audio track that describes what is shown |

The alternative must be labelled as such and discoverable from the media itself.
This criterion does not apply to media that is itself an alternative for text and
is labelled that way.

### How to test it

1. Classify each asset first. Audio-only, video-only, or video with audio. Video
   with audio belongs to 1.2.2, 1.2.3 and 1.2.5, not here.
2. Play or read the asset end to end. Write down the information it carries -
   facts, figures, names, instructions, outcomes, on-screen text.
3. Find the alternative on the page or linked from it. Read it end to end too.
4. Compare item by item. Does the alternative contain each thing the media
   carries? Name what is missing.
5. Check discoverability: a transcript exists only if a user can find it. A link
   adjacent to the player, or a disclosure below it, counts. A file on the server
   that nothing links to does not.
6. For video-only, check whether a described audio track exists as an alternative
   to the transcript. Either satisfies this criterion.

### Genuine failure

- A 24-minute recorded webinar with no transcript anywhere on the page.
- A transcript that reads "Audio recording about housing benefit" for a
  four-minute explanation of eligibility rules.
- A silent screen recording showing how to complete a form, with no transcript
  and no described audio - a blind user gets nothing at all.
- A transcript covering only the first speaker of a three-speaker panel.
- A transcript that omits the figures read aloud in the recording.
- A transcript hosted at a URL that appears in no link on the page.

### False positive - do not report

- A transcript on a separate linked page. Discoverable and linked from the media
  is acceptable; it does not have to be inline.
- A decorative background video with no audio and no information - an abstract
  loop behind a hero heading. Nothing is being conveyed, so nothing is owed.
- A transcript that paraphrases rather than transcribing verbatim, where every
  piece of information survives. Equivalence is the test, not stenography.
- An audio file that is itself an alternative to on-page text and is labelled as
  one.
- A transcript longer or more detailed than the recording.
- A video-only asset that has a described audio track but no transcript. Either
  one satisfies 1.2.1.

---

## 1.2.2 Captions (Prerecorded) - Level A

### What the standard requires

Captions are provided for all prerecorded audio content in synchronised media.
Captions are not a transcript: they are time-synchronised, they identify who is
speaking, and they label significant non-speech sound.

Judge three things, in this order of importance: **accuracy** against what is
actually said, **speaker identification**, and **labelling of significant
non-speech sound**.

### How to test it

1. Confirm a caption track exists and is selectable, or that captions are burned
   into the picture.
2. Play with captions on and follow the audio against the caption text. Do not
   read the caption file on its own - the failures live in the mismatch.
3. Log every divergence with its timestamp: dropped passages, wrong words that
   change meaning, numbers and names transcribed incorrectly, captions that lag
   or run ahead of the speech.
4. Where more than one person speaks, check that the captions attribute lines to
   speakers.
5. Check significant non-speech sound - an alarm, a phone ringing, laughter, a
   door, music that carries meaning. Sound that carries no information needs no
   caption.
6. Weigh each divergence by consequence. A misheard filler word is noise; a
   misheard eligibility rule, deadline, amount or instruction is serious.

### Genuine failure

- A video with no caption track at all and no burned-in captions.
- At 01:12 the speaker says "you may qualify" and the caption reads "you will
  qualify" - the caption states a guarantee the speaker did not give.
- Captions that stop 90 seconds into a six-minute video.
- A caption track in the wrong language, or auto-translated into gibberish.
- A three-person panel captioned as one undifferentiated stream, so no line can
  be attributed.
- A fire alarm sounding through a safety demonstration with no `[alarm sounding]`
  caption.
- Captions offset by several seconds throughout, so they no longer match the
  speaker.
- An amount read as "sixteen thousand" captioned as "sixty thousand".

### False positive - do not report

- **Open captions burned into the video.** They are still captions. Report them
  only if they are inaccurate, not for being non-selectable.
- Auto-generated captions that are merely imperfect - occasional punctuation
  slips, a missed filler word, an inconsistent brand-name capitalisation. Note
  them at low severity. A garbled eligibility rule, deadline or amount is a
  different matter and is serious.
- Captions that condense verbatim speech while preserving meaning.
- Missing captions for background music that carries no information.
- A caption style you find hard to read. Presentation is 1.4.3 and 1.4.11
  territory, and other lanes own it.
- A transcript offered as well as captions. Extra provision is not a failure.
- Silence, or a video with no audio content. There is nothing to caption; check
  it against 1.2.1 instead.

---

## 1.2.3 Audio Description or Media Alternative (Prerecorded) - Level A

### What the standard requires

For prerecorded synchronised media, **either** an audio description of the video
content **or** a full text media alternative. Level A gives the author the
choice.

A media alternative is a text document carrying everything the media conveys -
dialogue and the visual information both, in order.

### How to test it

1. Watch the video with the sound off and note every piece of information carried
   only by the picture: on-screen text and figures, a form being filled, a
   diagram, a demonstrated action, a location, who is doing what to whom.
2. Then check whether either remedy exists - a described audio track, or a text
   media alternative that is discoverable and linked.
3. If a media alternative exists, verify it carries the visual information from
   step 1, not just the dialogue. A dialogue-only transcript does not satisfy
   1.2.3 when meaning is carried visually.
4. If a described track exists, play it and confirm the descriptions land in the
   gaps and cover the visual information.
5. Name precisely which visual information is lost. That list is the finding.

### Genuine failure

- A tutorial video where the presenter says "enter it here" while pointing at a
  field, with no description and a dialogue-only transcript.
- On-screen figures shown but never spoken, absent from every alternative.
- A demonstration whose steps are performed silently on screen.
- A transcript that reproduces the narration and omits everything shown.
- A video whose closing frame carries the deadline and phone number, mentioned
  nowhere in the audio or the alternative.

### False positive - do not report

- A **transcript that also carries the visual information**. That is a valid
  media alternative and it satisfies 1.2.3 - though note that it does **not**
  satisfy 1.2.5, which is a separate finding below.
- A video whose narration already describes everything shown - a talking head
  with no visual information beyond the speaker.
- Decorative b-roll behind narration that adds nothing.
- A described version offered as a separate linked video.
- A media alternative on its own linked page, where the link is discoverable from
  the media.

---

## 1.2.5 Audio Description (Prerecorded) - Level AA

### What the standard requires

An audio description is provided for all prerecorded video content in
synchronised media. At AA the choice offered at 1.2.3 disappears: a text
alternative no longer satisfies it. **A page can pass 1.2.3 with a full text
media alternative and still fail 1.2.5**, and where that is the situation you
report the 1.2.5 finding and not a 1.2.3 one.

### How to test it

1. Reuse the list of visually conveyed information from 1.2.3.
2. Look specifically for a described audio track: a second audio track in the
   player, a described version of the video linked separately, or descriptions
   already fitted into the original narration.
3. Play the described track and confirm the descriptions cover the visual
   information and fit the natural pauses.
4. Where the only remedy on the page is a text alternative, that is a 1.2.5
   failure even though 1.2.3 is satisfied. Say exactly that in `detail` so the
   reviewer does not read it as a duplicate.
5. Where the original narration already describes everything shown, no separate
   track is needed. Say why you concluded that.

### Genuine failure

- A video with a complete text transcript covering the visuals, and no described
  audio track anywhere - passes 1.2.3, fails 1.2.5.
- A player offering only captions and a transcript, with no audio-description
  toggle and no linked described version.
- A described track that covers the first minute only.
- A described version linked but returning a 404.
- Descriptions that talk over the dialogue rather than filling the gaps.

### False positive - do not report

- Integrated description - narration that already speaks the on-screen
  information as it appears. No separate track is required.
- A video with no visual information beyond a speaker's face.
- A described version on a separate page, discoverable and linked.
- Decorative or silent background video carrying no information.
- Audio-only content. There is no video to describe; that is 1.2.1.

---

## Not in this skill - 1.2.4 Captions (Live) is BLOCKED

Do not report 1.2.4 under any circumstances, and never claim the page passes it.
A live stream that is not running cannot be audited, so the harness classes the
criterion as BLOCKED and it is not in this lane's criterion list - a 1.2.4
finding is rejected by the response schema and the pass is wasted.

If you find a live-stream player on the page, judge only the prerecorded assets
you were given. If a recording of a past live event is on the page, that is
prerecorded media and it is judged under 1.2.2 like anything else.

---

## Reporting rules for this group

- **Verdict is always FLAG.** Every finding, every criterion, every level of
  confidence. The schema for this lane accepts nothing else.
- One finding per media asset per criterion. A video with no captions, no
  description and no transcript produces three findings - 1.2.2, 1.2.3 and 1.2.5
  - not one complaint about the video. A page with four videos in that state
  produces twelve.
- Evidence is timestamped and quoted. "Captions are inaccurate" is unusable to
  the reviewer signing this off. "At 01:12 the speaker says 'you may qualify' and
  the caption reads 'you will qualify'" is a finding a person can check in ten
  seconds. Give the timestamp, the words spoken and the words shown.
- Severity is about the consequence of the mistake, not its frequency. A garbled
  eligibility rule, deadline, amount, dosage or safety instruction is `critical`
  or `serious` even if it is the only error in the file. An entirely uncaptioned
  video in the main task flow is `critical`. Cosmetic auto-caption imperfections
  across a marketing video are `minor`.
- Never describe media you did not actually play or read. If an asset would not
  load, was behind authentication, or was served by a player you could not drive,
  say so in `detail` and report what you could observe. Never infer that captions
  are absent because you could not find the control.
- Never invent a selector, a URL, a timestamp or a quotation. A fabricated
  timestamp destroys the reviewer's trust in the whole queue.
