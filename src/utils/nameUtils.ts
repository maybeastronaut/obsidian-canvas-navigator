export function cleanName(text: string): string {
    return text.replace(/^[\d.\-_]+\s+/, '');
}
