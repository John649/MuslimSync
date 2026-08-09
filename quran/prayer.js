// Prayer time calculation, offline.
//
// The standard astronomical method: solar declination and the equation of time
// from the Julian date, then hour angles for the sun altitudes each prayer is
// defined by. No network and no lookup tables, so times work on a plane and in
// a sandbox, and a test can pin them exactly.
//
// Everything is computed in UTC and handed back as Date objects; the caller's
// locale turns them into wall-clock times. That sidesteps timezone math
// entirely — the one place it matters is which *solar day* to compute, which
// the caller states by passing local year/month/day.
//
// Validated against aladhan.com for New York and Mecca (see prayer.test.js);
// agreement is within two minutes, which is the spread between published
// sources anyway — rounding conventions differ.

const RAD = Math.PI / 180;

/** Calculation methods: the Fajr/Isha sun angles each convention uses. */
export const METHODS = {
  // Muslim World League — the widest default.
  mwl: { fajr: 18, isha: 17 },
  // Islamic Society of North America.
  isna: { fajr: 15, isha: 15 },
  // Egyptian General Authority of Survey.
  egypt: { fajr: 19.5, isha: 17.5 },
  // Umm al-Qura, Mecca: Isha is fixed at 90 minutes after Maghrib.
  makkah: { fajr: 18.5, ishaMinutes: 90 },
  // University of Islamic Sciences, Karachi.
  karachi: { fajr: 18, isha: 18 },
};

export const PRAYERS = ["fajr", "sunrise", "dhuhr", "asr", "maghrib", "isha"];

/** Days since J2000.0 for a UTC date, fractional. */
function julianDays(year, month, day, hoursUtc = 12) {
  // Meeus' formula via the Unix epoch is overkill here; Date.UTC is exact for
  // the Gregorian calendar and immune to transcription slips.
  const ms = Date.UTC(year, month - 1, day) + hoursUtc * 3600000;
  return ms / 86400000 - 10957.5; // days since 2000-01-01T12:00Z
}

/** Solar declination (degrees) and equation of time (hours). NOAA's short form. */
function sun(days) {
  const g = (357.529 + 0.98560028 * days) % 360; // mean anomaly
  const q = (280.459 + 0.98564736 * days) % 360; // mean longitude
  const l = q + 1.915 * Math.sin(g * RAD) + 0.02 * Math.sin(2 * g * RAD); // ecliptic longitude

  const e = 23.439 - 0.00000036 * days; // obliquity

  const declination = Math.asin(Math.sin(e * RAD) * Math.sin(l * RAD)) / RAD;

  let ra = Math.atan2(Math.cos(e * RAD) * Math.sin(l * RAD), Math.cos(l * RAD)) / RAD / 15;
  ra = (ra + 24) % 24;

  const equationOfTime = q / 15 - ra;

  return { declination, equationOfTime };
}

/**
 * Hours from solar noon until the sun reaches `angle` degrees below the
 * horizon. NaN inside polar circles when the sun never gets there — the caller
 * surfaces that rather than inventing a time.
 */
function hoursFromNoon(angle, latitude, declination) {
  const numerator = -Math.sin(angle * RAD) - Math.sin(latitude * RAD) * Math.sin(declination * RAD);
  const denominator = Math.cos(latitude * RAD) * Math.cos(declination * RAD);
  const cos = numerator / denominator;

  if (cos < -1 || cos > 1) return NaN;

  return Math.acos(cos) / RAD / 15;
}

/** Hours from noon for Asr: when a shadow is `factor`× object height + noon shadow. */
function asrHours(factor, latitude, declination) {
  const altitude = Math.atan(1 / (factor + Math.tan(Math.abs(latitude - declination) * RAD))) / RAD;
  return hoursFromNoon(-altitude, latitude, declination);
}

/**
 * Prayer times for one solar day at one place.
 *
 * `date` is {year, month (1-12), day} in the place's own calendar — the local
 * date, since "today's Fajr" means today where you are, not today in UTC.
 * Returns { fajr, sunrise, dhuhr, asr, maghrib, isha } as Dates, and any that
 * cannot occur (polar summer) as null.
 */
export function prayerTimes({ year, month, day }, { latitude, longitude }, options = {}) {
  const method = METHODS[options.method ?? "mwl"];
  if (!method) throw new Error(`unknown method "${options.method}" — one of: ${Object.keys(METHODS).join(", ")}`);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`latitude must be -90..90, got ${latitude}`);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`longitude must be -180..180, got ${longitude}`);

  // Hanafi Asr uses shadow factor 2; the standard (Shafi'i et al.) uses 1.
  const asrFactor = options.asr === "hanafi" ? 2 : 1;

  // Iterate once: solar noon depends on the equation of time, which we first
  // evaluate at an approximate noon for this longitude.
  const approxNoonUtc = 12 - longitude / 15;
  const { declination, equationOfTime } = sun(julianDays(year, month, day, approxNoonUtc));

  const noon = 12 - longitude / 15 - equationOfTime; // UTC hours

  // Sunrise and sunset use the standard refraction-plus-semidiameter altitude.
  const horizon = hoursFromNoon(0.833, latitude, declination);
  const fajrOffset = hoursFromNoon(method.fajr, latitude, declination);
  const asrOffset = asrHours(asrFactor, latitude, declination);

  const at = (hoursUtc) => {
    if (!Number.isFinite(hoursUtc)) return null;
    return new Date(Date.UTC(year, month - 1, day) + Math.round(hoursUtc * 3600000));
  };

  const maghrib = at(noon + horizon);

  let isha;
  if (method.ishaMinutes) {
    isha = maghrib && new Date(maghrib.getTime() + method.ishaMinutes * 60000);
  } else {
    isha = at(noon + hoursFromNoon(method.isha, latitude, declination));
  }

  return {
    fajr: at(noon - fajrOffset),
    sunrise: at(noon - horizon),
    dhuhr: at(noon),
    asr: at(noon + asrOffset),
    maghrib,
    isha,
  };
}

/**
 * The next prayer strictly after `now`, looking into tomorrow when today's are
 * done. Sunrise is included — it ends Fajr's window, which is worth a nudge —
 * unless the caller opts out.
 *
 * Returns { name, time } or null when nothing is computable (polar edge).
 */
export function nextPrayer(now, location, options = {}) {
  const names = options.includeSunrise === false ? PRAYERS.filter((p) => p !== "sunrise") : PRAYERS;

  for (const dayOffset of [0, 1]) {
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
    const times = prayerTimes(
      { year: local.getFullYear(), month: local.getMonth() + 1, day: local.getDate() },
      location,
      options,
    );

    for (const name of names) {
      const time = times[name];
      if (time && time.getTime() > now.getTime()) return { name, time };
    }
  }

  return null;
}
