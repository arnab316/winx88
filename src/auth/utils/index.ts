export function generateUsername(fullName: string, email: string): string {
    // Take lowercase initials of full name
    const initials = fullName
        .split(' ')
        .map(word => word[0])
        .join('')
        .toLowerCase();

    // Take first 3 letters of email (before @)
    const emailPart = email.split('@')[0].substring(0, 3).toLowerCase();

    // Add a random 3-digit number
    const randomNum = Math.floor(100 + Math.random() * 900); // 100–999

    return `${initials}${emailPart}${randomNum}`; // e.g., jdjo123
}

// Format: WINX88 + 2-digit year + first 3 letters of username (padded with
// 'X' if the username is shorter). E.g. username "jo" in 2026 -> WINX8826JOX.
// This is also the affiliate code (?aff=<user_code> tracking links), so it
// intentionally carries the brand + year for readability at a glance.
export function generateUserCode(username: string): string {
    const year2 = String(new Date().getFullYear()).slice(-2);
    const namePart = (username || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 3)
        .padEnd(3, 'X');

    return `WINX88${year2}${namePart}`;
}

// The permanent invite code shared in the referral link
// (https://site/register?ref=RAKIB8X2F). Built from the username/full name +
// a random suffix. Uniqueness is enforced by the DB; callers retry on clash.
export function generateReferralCode(seed: string): string {
    const base =
        (seed || 'USER')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 6) || 'USER';
    const suffix = Math.random()
        .toString(36)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 4)
        .padEnd(4, 'X');
    return `${base}${suffix}`;
}