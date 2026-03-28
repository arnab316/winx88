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

export function generateUserCode(fullName: string, email: string): string {
    // Take initials of full name
    const initials = fullName
        .split(' ')
        .map(word => word[0])
        .join('')
        .toUpperCase();

    // Take first 3 letters of email (before @)
    const emailPart = email.split('@')[0].substring(0, 3).toUpperCase();

    // Add a random 4-character alphanumeric string
    const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();

    return `${initials}${emailPart}${randomStr}`; // e.g., JDJOH1A2B
}