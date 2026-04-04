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