"""Western and Chinese zodiac helpers for TTS forecast add-ons.

The Chinese portion uses the full sexagenary (60-year) cycle, so each lunar
year carries an element (Wood/Fire/Earth/Metal/Water), an animal, and a
polarity (Yin/Yang) - not just the animal. The combination is resolved with the
standard stem-branch formula: index = (lunar_year - 4) mod 60.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any

WESTERN_ZODIAC: tuple[dict[str, str], ...] = (
    {
        "name": "Aries",
        "element": "Fire",
        "quality": "Cardinal",
        "theme": "initiation",
        "focus": (
            "courage, decisive action, and starting necessary work, "
            "while controlling impulsiveness"
        ),
    },
    {
        "name": "Taurus",
        "element": "Earth",
        "quality": "Fixed",
        "theme": "establishment",
        "focus": (
            "stability, patience, stewardship, and building resources, "
            "while resisting stagnation"
        ),
    },
    {
        "name": "Gemini",
        "element": "Air",
        "quality": "Mutable",
        "theme": "communication",
        "focus": (
            "learning, exchanging ideas, and listening carefully, "
            "while separating truth from noise"
        ),
    },
    {
        "name": "Cancer",
        "element": "Water",
        "quality": "Cardinal",
        "theme": "protection",
        "focus": (
            "home, family, emotional maturity, and healthy boundaries, "
            "while caring without controlling"
        ),
    },
    {
        "name": "Leo",
        "element": "Fire",
        "quality": "Fixed",
        "theme": "expression",
        "focus": (
            "leadership, creativity, confidence, and generosity, "
            "while overcoming pride"
        ),
    },
    {
        "name": "Virgo",
        "element": "Earth",
        "quality": "Mutable",
        "theme": "refinement",
        "focus": (
            "discipline, service, organization, and health, "
            "while correcting problems without perfectionism"
        ),
    },
    {
        "name": "Libra",
        "element": "Air",
        "quality": "Cardinal",
        "theme": "balance",
        "focus": (
            "justice, cooperation, relationships, and wise compromise, "
            "while making fair decisions"
        ),
    },
    {
        "name": "Scorpio",
        "element": "Water",
        "quality": "Fixed",
        "theme": "transformation",
        "focus": (
            "confronting hidden problems, repentance, healing, and endurance, "
            "while releasing unhealthy attachments"
        ),
    },
    {
        "name": "Sagittarius",
        "element": "Fire",
        "quality": "Mutable",
        "theme": "expansion",
        "focus": (
            "study, travel, vision, and truth-seeking, "
            "while developing conviction without becoming reckless"
        ),
    },
    {
        "name": "Capricorn",
        "element": "Earth",
        "quality": "Cardinal",
        "theme": "responsibility",
        "focus": (
            "long-term planning, work, structure, authority, and patience, "
            "while building something durable"
        ),
    },
    {
        "name": "Aquarius",
        "element": "Air",
        "quality": "Fixed",
        "theme": "reform",
        "focus": (
            "community, innovation, systems thinking, "
            "and questioning harmful traditions, while avoiding detachment"
        ),
    },
    {
        "name": "Pisces",
        "element": "Water",
        "quality": "Mutable",
        "theme": "surrender",
        "focus": (
            "compassion, prayer, imagination, and forgiveness, "
            "while maintaining spiritual reflection and discernment"
        ),
    },
)

# Full 60-year sexagenary cycle. Index 0 == "Wood Rat" (Jia-Zi), matching the
# formula index = (lunar_year - 4) mod 60. Each entry carries element, animal,
# polarity, prevailing theme, what to work toward, and the main caution.
SEXAGENARY_CYCLE: tuple[dict[str, str], ...] = (
    {"element": "Wood", "animal": "Rat", "polarity": "Yang", "theme": "strategic growth and new opportunities", "focus": "build networks, gather resources, and begin intelligent plans", "caution": "manipulation, opportunism, and scattered priorities"},
    {"element": "Wood", "animal": "Ox", "polarity": "Yin", "theme": "slow and steady development", "focus": "build durable foundations, improve skills, and remain consistent", "caution": "stubbornness and working without adapting"},
    {"element": "Fire", "animal": "Tiger", "polarity": "Yang", "theme": "bold action and confrontation", "focus": "lead courageously, defend others, and initiate necessary change", "caution": "aggression, recklessness, and unnecessary conflict"},
    {"element": "Fire", "animal": "Rabbit", "polarity": "Yin", "theme": "warmth, diplomacy, and social influence", "focus": "restore relationships, communicate gently, and create peace", "caution": "avoidance, emotional sensitivity, and indirect hostility"},
    {"element": "Earth", "animal": "Dragon", "polarity": "Yang", "theme": "large-scale building and authority", "focus": "establish structures, organize major projects, and accept responsibility", "caution": "pride, domination, and unrealistic ambition"},
    {"element": "Earth", "animal": "Snake", "polarity": "Yin", "theme": "practical discernment and careful planning", "focus": "study deeply, move patiently, and secure resources", "caution": "suspicion, secrecy, and excessive calculation"},
    {"element": "Metal", "animal": "Horse", "polarity": "Yang", "theme": "determined movement and independence", "focus": "pursue clear goals, travel, act decisively, and maintain discipline", "caution": "restlessness, harshness, and abandoning commitments"},
    {"element": "Metal", "animal": "Goat", "polarity": "Yin", "theme": "refined creativity and boundaries", "focus": "improve craftsmanship, establish standards, and protect emotional health", "caution": "perfectionism, withdrawal, and excessive criticism"},
    {"element": "Water", "animal": "Monkey", "polarity": "Yang", "theme": "adaptability, innovation, and communication", "focus": "experiment, solve problems, and learn new systems", "caution": "trickery, instability, and lack of seriousness"},
    {"element": "Water", "animal": "Rooster", "polarity": "Yin", "theme": "insightful correction and precise communication", "focus": "examine details, speak accurately, and improve routines", "caution": "gossip, overanalysis, and constant fault-finding"},
    {"element": "Wood", "animal": "Dog", "polarity": "Yang", "theme": "growth through loyalty and justice", "focus": "protect communities, build trustworthy alliances, and serve faithfully", "caution": "self-righteousness and taking on every battle"},
    {"element": "Wood", "animal": "Pig", "polarity": "Yin", "theme": "generosity, cultivation, and shared abundance", "focus": "develop supportive environments, invest patiently, and practice gratitude", "caution": "overgiving, comfort-seeking, and weak boundaries"},
    {"element": "Fire", "animal": "Rat", "polarity": "Yang", "theme": "rapid strategy and competitive movement", "focus": "act quickly on sound ideas and communicate persuasively", "caution": "impulsiveness, manipulation, and burnout"},
    {"element": "Fire", "animal": "Ox", "polarity": "Yin", "theme": "inner determination and sustained effort", "focus": "complete difficult work, strengthen discipline, and remain dependable", "caution": "suppressed anger, rigid routines, and overwork"},
    {"element": "Earth", "animal": "Tiger", "polarity": "Yang", "theme": "controlled courage and responsible leadership", "focus": "direct strength toward practical change and protection", "caution": "forcefulness, territorial behavior, and inflexibility"},
    {"element": "Earth", "animal": "Rabbit", "polarity": "Yin", "theme": "stability in home and relationships", "focus": "build peace, strengthen family structures, and create security", "caution": "passivity, fear of disruption, and complacency"},
    {"element": "Metal", "animal": "Dragon", "polarity": "Yang", "theme": "authority, refinement, and decisive reform", "focus": "cut away excess, establish standards, and execute a major vision", "caution": "arrogance, severity, and controlling behavior"},
    {"element": "Metal", "animal": "Snake", "polarity": "Yin", "theme": "precision, judgment, and hidden strength", "focus": "strengthen boundaries, research carefully, and choose timing wisely", "caution": "coldness, secrecy, and unforgiveness"},
    {"element": "Water", "animal": "Horse", "polarity": "Yang", "theme": "powerful movement and changing circumstances", "focus": "adapt quickly, explore, communicate, and direct momentum", "caution": "instability, emotional impulsiveness, and lack of roots"},
    {"element": "Water", "animal": "Goat", "polarity": "Yin", "theme": "compassion, imagination, and emotional depth", "focus": "heal, create, reflect, and support others without losing yourself", "caution": "escapism, emotional overwhelm, and dependency"},
    {"element": "Wood", "animal": "Monkey", "polarity": "Yang", "theme": "inventive growth and experimentation", "focus": "develop new tools, learn rapidly, and connect ideas", "caution": "cutting corners, distraction, and cleverness without wisdom"},
    {"element": "Wood", "animal": "Rooster", "polarity": "Yin", "theme": "improvement through disciplined cultivation", "focus": "refine habits, organize work, and teach clearly", "caution": "perfectionism, criticism, and obsession with appearances"},
    {"element": "Fire", "animal": "Dog", "polarity": "Yang", "theme": "passionate loyalty and moral action", "focus": "defend truth, confront injustice, and energize a community", "caution": "anger, suspicion, and moral superiority"},
    {"element": "Fire", "animal": "Pig", "polarity": "Yin", "theme": "warm generosity and joyful expression", "focus": "celebrate responsibly, strengthen relationships, and share resources", "caution": "excess, indulgence, and trusting too easily"},
    {"element": "Earth", "animal": "Rat", "polarity": "Yang", "theme": "resource management and practical strategy", "focus": "save, plan, secure foundations, and use opportunities wisely", "caution": "hoarding, anxiety, and calculating relationships"},
    {"element": "Earth", "animal": "Ox", "polarity": "Yin", "theme": "endurance, stability, and long-term construction", "focus": "build patiently, honor commitments, and strengthen finances", "caution": "stagnation, resistance to change, and excessive duty"},
    {"element": "Metal", "animal": "Tiger", "polarity": "Yang", "theme": "sharp courage and forceful reform", "focus": "confront corruption, act decisively, and protect boundaries", "caution": "ruthlessness, unnecessary rebellion, and aggression"},
    {"element": "Metal", "animal": "Rabbit", "polarity": "Yin", "theme": "graceful boundaries and diplomatic judgment", "focus": "resolve conflict fairly, refine relationships, and preserve dignity", "caution": "emotional distance and avoidance behind politeness"},
    {"element": "Water", "animal": "Dragon", "polarity": "Yang", "theme": "expansive vision and powerful change", "focus": "think broadly, adapt leadership, and communicate a compelling purpose", "caution": "grandiosity, unstable ambitions, and emotional force"},
    {"element": "Water", "animal": "Snake", "polarity": "Yin", "theme": "intuition, strategy, and hidden movement", "focus": "observe carefully, study motives, and prepare before acting", "caution": "deception, fear, and excessive secrecy"},
    {"element": "Wood", "animal": "Horse", "polarity": "Yang", "theme": "expansion through movement and initiative", "focus": "start projects, travel, build connections, and pursue independence", "caution": "overextension, impatience, and unfinished work"},
    {"element": "Wood", "animal": "Goat", "polarity": "Yin", "theme": "creative development and community cultivation", "focus": "nurture talent, improve environments, and strengthen cooperation", "caution": "indecision, sensitivity, and dependence on approval"},
    {"element": "Fire", "animal": "Monkey", "polarity": "Yang", "theme": "fast innovation, persuasion, and disruption", "focus": "experiment boldly, communicate ideas, and solve urgent problems", "caution": "arrogance, dishonesty, and reckless risk-taking"},
    {"element": "Fire", "animal": "Rooster", "polarity": "Yin", "theme": "visible excellence and passionate correction", "focus": "present work confidently, improve standards, and speak with purpose", "caution": "vanity, harsh criticism, and dramatic conflict"},
    {"element": "Earth", "animal": "Dog", "polarity": "Yang", "theme": "dependability, justice, and institutional stability", "focus": "protect what is valuable, create fair systems, and serve consistently", "caution": "cynicism, rigidity, and excessive suspicion"},
    {"element": "Earth", "animal": "Pig", "polarity": "Yin", "theme": "material stability and generous stewardship", "focus": "manage resources, care for others, and enjoy earned results responsibly", "caution": "laziness, overconsumption, and weak discipline"},
    {"element": "Metal", "animal": "Rat", "polarity": "Yang", "theme": "sharp strategy and efficient acquisition", "focus": "negotiate, simplify, protect resources, and make precise decisions", "caution": "manipulation, greed, and emotional coldness"},
    {"element": "Metal", "animal": "Ox", "polarity": "Yin", "theme": "discipline, resilience, and uncompromising labor", "focus": "master a craft, fulfill obligations, and strengthen boundaries", "caution": "severe judgment, inflexibility, and emotional suppression"},
    {"element": "Water", "animal": "Tiger", "polarity": "Yang", "theme": "emotional power and unpredictable action", "focus": "direct passion wisely, adapt during conflict, and lead with understanding", "caution": "volatility, impulsiveness, and destructive rebellion"},
    {"element": "Water", "animal": "Rabbit", "polarity": "Yin", "theme": "sensitivity, healing, and subtle diplomacy", "focus": "listen, reconcile, create emotional safety, and practice discernment", "caution": "escapism, indecision, and absorbing others' emotions"},
    {"element": "Wood", "animal": "Dragon", "polarity": "Yang", "theme": "visionary growth and large beginnings", "focus": "launch meaningful ventures, inspire others, and expand responsibly", "caution": "ego, taking on too much, and forcing progress"},
    {"element": "Wood", "animal": "Snake", "polarity": "Yin", "theme": "patient cultivation and strategic development", "focus": "study, mentor, build quietly, and allow ideas to mature", "caution": "overplanning, secrecy, and passive manipulation"},
    {"element": "Fire", "animal": "Horse", "polarity": "Yang", "theme": "intense movement, independence, and rapid change", "focus": "act decisively, pursue freedom responsibly, and channel passion", "caution": "burnout, rebellion, instability, and conflict"},
    {"element": "Fire", "animal": "Goat", "polarity": "Yin", "theme": "inspired creativity and emotional warmth", "focus": "create beauty, encourage others, and express compassion", "caution": "drama, oversensitivity, and seeking constant validation"},
    {"element": "Earth", "animal": "Monkey", "polarity": "Yang", "theme": "practical intelligence and system-building", "focus": "turn ideas into usable tools, organize innovation, and solve real problems", "caution": "opportunism, shortcuts, and excessive control"},
    {"element": "Earth", "animal": "Rooster", "polarity": "Yin", "theme": "order, accountability, and precise improvement", "focus": "establish routines, audit details, and improve quality", "caution": "nitpicking, rigidity, and obsession with correctness"},
    {"element": "Metal", "animal": "Dog", "polarity": "Yang", "theme": "strong justice, protection, and firm loyalty", "focus": "enforce boundaries, defend principles, and remove corruption", "caution": "harsh judgment, distrust, and inability to forgive"},
    {"element": "Metal", "animal": "Pig", "polarity": "Yin", "theme": "refined abundance and responsible enjoyment", "focus": "share wisely, simplify possessions, and preserve quality", "caution": "materialism, indulgence, and emotional detachment"},
    {"element": "Water", "animal": "Rat", "polarity": "Yang", "theme": "flowing strategy, information, and mobility", "focus": "gather knowledge, adapt plans, and communicate across groups", "caution": "deception, anxiety, and constantly changing direction"},
    {"element": "Water", "animal": "Ox", "polarity": "Yin", "theme": "quiet endurance and emotional resilience", "focus": "continue patiently, conserve energy, and adapt without abandoning duty", "caution": "silent resentment, passivity, and carrying excessive burdens"},
    {"element": "Wood", "animal": "Tiger", "polarity": "Yang", "theme": "expansive courage and pioneering growth", "focus": "begin reforms, develop leadership, and protect emerging work", "caution": "aggression, impatience, and uncontrolled ambition"},
    {"element": "Wood", "animal": "Rabbit", "polarity": "Yin", "theme": "gentle growth and relational renewal", "focus": "repair trust, cultivate peace, and improve home and community", "caution": "avoiding hard truth, dependency, and excessive caution"},
    {"element": "Fire", "animal": "Dragon", "polarity": "Yang", "theme": "powerful visibility, ambition, and transformation", "focus": "lead boldly, present a vision, and mobilize others", "caution": "pride, domination, and dramatic overreach"},
    {"element": "Fire", "animal": "Snake", "polarity": "Yin", "theme": "focused insight and persuasive influence", "focus": "illuminate hidden matters, teach, plan carefully, and act at the right moment", "caution": "manipulation, jealousy, and concealed anger"},
    {"element": "Earth", "animal": "Horse", "polarity": "Yang", "theme": "productive movement and practical independence", "focus": "advance projects, maintain momentum, and build reliable routines", "caution": "workaholism, impatience, and resisting emotional needs"},
    {"element": "Earth", "animal": "Goat", "polarity": "Yin", "theme": "stability through care, craft, and community", "focus": "improve living conditions, nurture relationships, and create dependable support", "caution": "worry, stagnation, and carrying others excessively"},
    {"element": "Metal", "animal": "Monkey", "polarity": "Yang", "theme": "technical mastery and strategic disruption", "focus": "engineer solutions, remove inefficiency, and use intelligence responsibly", "caution": "exploitation, arrogance, and emotional detachment"},
    {"element": "Metal", "animal": "Rooster", "polarity": "Yin", "theme": "exactness, discipline, and visible standards", "focus": "perfect important work, speak truth clearly, and maintain accountability", "caution": "severe criticism, vanity, and inflexibility"},
    {"element": "Water", "animal": "Dog", "polarity": "Yang", "theme": "compassionate protection and responsive justice", "focus": "listen before judging, defend vulnerable people, and adapt loyally", "caution": "emotional defensiveness, suspicion, and pessimism"},
    {"element": "Water", "animal": "Pig", "polarity": "Yin", "theme": "completion, mercy, and emotional abundance", "focus": "rest, forgive, share, conclude old cycles, and prepare for renewal", "caution": "escapism, overindulgence, and poor boundaries"},
)

# Gregorian Lunar New Year starts (month, day) keyed by the Gregorian year the holiday falls in.
_LUNAR_NEW_YEAR: dict[int, tuple[int, int]] = {
    2018: (2, 16),
    2019: (2, 5),
    2020: (1, 25),
    2021: (2, 12),
    2022: (2, 1),
    2023: (1, 22),
    2024: (2, 10),
    2025: (1, 29),
    2026: (2, 17),
    2027: (2, 6),
    2028: (1, 26),
    2029: (2, 13),
    2030: (2, 3),
}


def _as_date(when: datetime | date | None = None) -> date:
    if when is None:
        return datetime.now().date()
    if isinstance(when, datetime):
        return when.date()
    return when


def _lower_first(text: str) -> str:
    return (text[:1].lower() + text[1:]) if text else text


def western_sun_sign(when: datetime | date | None = None) -> dict[str, str]:
    """Return the tropical western sun sign for a calendar date."""
    d = _as_date(when)
    md = (d.month, d.day)
    ranges: tuple[tuple[tuple[int, int], tuple[int, int], int], ...] = (
        ((3, 21), (4, 19), 0),
        ((4, 20), (5, 20), 1),
        ((5, 21), (6, 20), 2),
        ((6, 21), (7, 22), 3),
        ((7, 23), (8, 22), 4),
        ((8, 23), (9, 22), 5),
        ((9, 23), (10, 22), 6),
        ((10, 23), (11, 21), 7),
        ((11, 22), (12, 21), 8),
        ((12, 22), (12, 31), 9),
        ((1, 1), (1, 19), 9),
        ((1, 20), (2, 18), 10),
        ((2, 19), (3, 20), 11),
    )
    idx = 11
    for start, end, sign_idx in ranges:
        if start <= md <= end:
            idx = sign_idx
            break
    sign = WESTERN_ZODIAC[idx]
    return {
        "name": sign["name"],
        "element": sign["element"],
        "quality": sign["quality"],
        "theme": sign["theme"],
        "focus": sign["focus"],
    }


def _lunar_year(when: datetime | date | None = None) -> int:
    """Gregorian year of the lunar year containing *when* (LNY boundary aware)."""
    d = _as_date(when)
    year = d.year
    month, day = _LUNAR_NEW_YEAR.get(year, (2, 4))
    if (d.month, d.day) < (month, day):
        year -= 1
    return year


def chinese_zodiac_year(when: datetime | date | None = None) -> dict[str, Any]:
    """Return the full sexagenary combination for the lunar year containing *when*.

    Includes element, animal, polarity (Yin/Yang), and the guidance fields
    (theme/focus/caution) for that specific element-animal-polarity combination.
    """
    year = _lunar_year(when)
    # Index 0 of the cycle == "Wood Rat" == year 4 AD (Jia-Zi).
    idx = (year - 4) % 60
    combo = SEXAGENARY_CYCLE[idx]
    return {
        "name": combo["animal"],
        "animal": combo["animal"],
        "element": combo["element"],
        "polarity": combo["polarity"],
        "yin": combo["polarity"] == "Yin",
        "combination": f"{combo['element']} {combo['animal']}",
        "cycle_index": idx,
        "year": year,
        "theme": combo["theme"],
        "focus": combo["focus"],
        "caution": combo["caution"],
    }


def build_western_zodiac_guidance(when: datetime | date | None = None) -> str:
    """Life-focus guidance for the current western sun sign."""
    sign = western_sun_sign(when)
    return (
        f"In the western zodiac, the sun is in {sign['name']}, "
        f"a season of {sign['theme']}. "
        f"Work toward {sign['focus']}."
    )


def build_chinese_zodiac_guidance(when: datetime | date | None = None) -> str:
    """Life-focus guidance for the current Chinese sexagenary year."""
    combo = chinese_zodiac_year(when)
    return (
        f"In the Chinese zodiac, this is the year of the "
        f"{combo['element']} {combo['animal']}, "
        f"a {combo['polarity']} year of {_lower_first(combo['theme'])}. "
        f"This year, {_lower_first(combo['focus'])}. "
        f"Be mindful of {_lower_first(combo['caution'])}."
    )


def build_zodiac_forecast_section(
    tts_config: dict[str, Any],
    when: datetime | date | None = None,
) -> str | None:
    """Build optional zodiac life-focus guidance for scheduled forecasts."""
    include_western = bool(tts_config.get("include_western_zodiac"))
    include_chinese = bool(tts_config.get("include_chinese_zodiac"))
    if not include_western and not include_chinese:
        return None

    parts: list[str] = []
    if include_western:
        parts.append(build_western_zodiac_guidance(when))
    if include_chinese:
        parts.append(build_chinese_zodiac_guidance(when))
    return " ".join(parts)
