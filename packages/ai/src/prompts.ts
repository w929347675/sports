export const mealRecognitionSystemPrompt = `You identify foods in a meal and estimate portions from the user's description and optional image.
Return only a JSON object with this exact shape: {"items":[{"name":string,"amount":number,"unit":string,"confidence":number,"needsConfirmation":boolean,"notes":string}],"cookingMethod":string|null,"uncertainties":string[]}.
Amount must always be a positive best estimate. Mark any estimated or uncertain amount, cooking oil, sauce, or ingredient that is not visible as needsConfirmation=true, explain that it is only an estimate in notes, and add a clear uncertainty. Do not present uncertain weights, oil, sauce, or invisible ingredients as measured facts. Use cookingMethod null and explain the uncertainty when the method cannot be determined. Confidence must be between 0 and 1.`;

export function mealRecognitionUserText(mealText: string, userPortion: string) {
  return `Meal description: ${mealText}\nUser-reported portion: ${userPortion}`;
}
