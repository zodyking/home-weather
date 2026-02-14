# Home Weather TTS Output Examples

This document shows example TTS output for each trigger type in the Home Weather integration.

---

## Message Format Structure

All TTS messages follow this pattern:

```
"Good [morning/afternoon/evening/night], the time is [time in words], [message content]"
```

**Time Examples:**
- 7:00 AM → "seven AM"
- 7:05 AM → "seven oh five AM"
- 8:15 PM → "eight fifteen PM"
- 12:00 PM → "twelve PM"

**Greeting Rules:**
- 5:00 AM - 11:59 AM → "Good morning"
- 12:00 PM - 4:59 PM → "Good afternoon"
- 5:00 PM - 8:59 PM → "Good evening"
- 9:00 PM - 4:59 AM → "Good night"

---

## 1. Scheduled/Time-Based Forecast

**Trigger:** Runs at configured times (e.g., every 3 hours from 8 AM to 9 PM)

**Example Output (8:07 AM, partly cloudy, 62°F):**

```
Good morning, the time is eight oh seven AM, and here's your weather forecast. 
Right now it's sixty two degrees with partly cloudy. 
Today expect partly cloudy with a high of seventy five degrees and a low of fifty two degrees. 
Expect rain in about an hour with a forty percent chance. 
Watch for wind gusts up to thirty five miles per hour around eleven AM. 
Tomorrow looks like sunny with a high near eighty degrees.
```

**With Custom Prefix ("your daily weather update"):**

```
Good morning, the time is eight oh seven AM, and your daily weather update. 
Right now it's sixty two degrees with partly cloudy...
```

**With Name (via conversation/satellite):**

```
Good morning, the time is eight oh seven AM Brandon, and here's your weather forecast. 
Right now it's sixty two degrees with partly cloudy...
```

---

## 2. Webhook Trigger (Alarm Wake-Up)

**Trigger:** Phone alarm webhook fires (short, focused on today only)

**Example Output (7:05 AM, clear, 58°F):**

```
Good morning, the time is seven oh five AM. 
Currently fifty eight degrees and clear. 
High of seventy two degrees, low of forty eight degrees. 
No precipitation expected today.
```

**With Precipitation Expected:**

```
Good morning, the time is seven oh five AM. 
Currently fifty eight degrees and cloudy. 
High of sixty eight degrees, low of fifty degrees. 
Rain expected in a couple hours. 
Gusty winds around eleven AM.
```

**With Name ("Brandon" configured in webhook):**

```
Good morning, the time is seven oh five AM Brandon. 
Currently fifty eight degrees and clear...
```

---

## 3. Current Weather Change Alert

**Trigger:** Weather condition changes (e.g., sunny → rainy)

**Example Output (2:30 PM, changed to thunderstorms, 78°F):**

```
Good afternoon, the time is two thirty PM, weather alert. 
Conditions have changed to thunderstorms, and it's currently seventy eight degrees.
```

**Without Temperature Data:**

```
Good afternoon, the time is two thirty PM, weather alert. 
Conditions have changed to thunderstorms.
```

---

## 4. Upcoming Precipitation Alert

**Trigger:** Precipitation expected within configured time window

**Example Output (Rain in 25 minutes, 60% chance):**

```
Good afternoon, the time is three fifteen PM, weather alert. 
Rain expected in about twenty five minutes with a sixty percent chance.
```

**Very Soon (< 5 minutes):**

```
Good evening, the time is six forty five PM, weather alert. 
Snow expected very soon with a seventy percent chance.
```

**In About an Hour:**

```
Good morning, the time is nine AM, weather alert. 
Thunderstorms expected in about an hour with a fifty five percent chance.
```

---

## 5. Sensor-Triggered Forecast

**Trigger:** Configured sensor reaches trigger state (e.g., front door opens)

Uses the same format as **Scheduled Forecast** (#1 above).

**Example (triggered by motion sensor at 6:45 AM):**

```
Good morning, the time is six forty five AM, and here's your weather forecast. 
Right now it's fifty five degrees with fog. 
Today expect partly cloudy with a high of sixty eight degrees and a low of forty nine degrees. 
No precipitation expected today. 
Tomorrow looks like sunny with a high near seventy two degrees.
```

---

## 6. Voice Satellite / Conversation Trigger

**Trigger:** User asks "What is the weather?" via voice assistant

Uses the same format as **Scheduled Forecast** (#1 above), but may include user's name if available.

**Example:**

```
Good afternoon, the time is one thirty PM, and here's your weather forecast. 
Right now it's eighty two degrees with sunny. 
Today expect clear skies with a high of eighty eight degrees and a low of sixty five degrees. 
No precipitation expected today. 
Tomorrow looks like partly cloudy with a high near eighty five degrees.
```

---

## Configuration Options

### Message Intro (Prefix)

- **Default:** "here's your weather forecast"
- **Custom Examples:**
  - "your daily weather update"
  - "time to check the weather"
  - "your personalized forecast"

The prefix is spoken after the greeting+time, connected with "and":
```
Good morning, the time is eight AM, and [your prefix].
```

### Weather Thresholds

- **Precipitation Threshold:** Only mention precipitation if probability >= threshold (default: 30%)
- **Wind Speed Threshold:** Only mention winds if speed >= threshold (default: 15 mph)
- **Wind Gust Threshold:** Only mention gusts if speed >= threshold (default: 25 mph)

---

## Number Pronunciation

All numbers are spelled out for natural TTS:

| Number | Spoken |
|--------|--------|
| 0-19 | "zero" through "nineteen" |
| 20, 30... | "twenty", "thirty"... |
| 21 | "twenty one" |
| 100 | "one hundred" |
| 105 | "one hundred five" |
| -5 | "negative five" |

**Temperature Examples:**
- 72°F → "seventy two degrees"
- 100°F → "one hundred degrees"
- -3°F → "negative three degrees"

**Percentage Examples:**
- 45% → "forty five percent"
- 100% → "one hundred percent"

**Wind Examples:**
- 15 mph → "fifteen miles per hour"
- 25 mph → "twenty five miles per hour"
