/** Route__c service-type picklist values + their sub-types (mirrors Salesforce). */
export const SERVICE_TYPES = ['UCO Collection', 'Container Service', 'Grease Trap Service', 'Rotisserie Water'];

export const SUB_TYPES = {
  'Container Service': [
    'Automated System', 'Deliver Container', 'Deliver Oil Caddy',
    'Pressure Washing', 'Relocate Container', 'Remove Container',
    'Remove FSP Container', 'Replace Container', 'Replace Grill',
    'Replace Key', 'Replace Lock',
  ],
  'Grease Trap Service': ['Grease Trap Cleaning', 'Line Jetting'],
};
