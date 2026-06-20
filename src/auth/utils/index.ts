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

export function generateUserCode(fullName: string): string {
    const initials = fullName
        .trim()
        .split(' ')
        .filter(word => word.length > 0)
        .map(word => word[0])
        .join('')
        .toUpperCase();

    // Generate random 5-digit number
    const randomNumber = Math.floor(10000 + Math.random() * 90000);

    return `${initials}${randomNumber}`;
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