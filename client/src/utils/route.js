/**
 * True when a Google_Route__c is completed — matches the server-side filter
 * (Driver_Completed__c = true OR CompletionStatus__c = 'Completed').
 * Completed routes are read-only: stops cannot be added, edited or removed.
 */
export function isRouteCompleted(route) {
  return !!route && (!!route.Driver_Completed__c || route.CompletionStatus__c === 'Completed');
}
