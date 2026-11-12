import type { CredentialRequest } from '@/types/crm';

const HOUR = 3_600_000;

/**
 * Demonstration cards for the CRM board until requests are stored (later phase). `base` is the
 * time the page was rendered, so ages read naturally.
 */
export function sampleRequests(base: number): CredentialRequest[] {
  const at = (hoursAgo: number) => base - hoursAgo * HOUR;
  return [
    {
      id: 'rq-101',
      stage: 'new',
      recipientName: 'Aarav Sharma',
      credential: 'Class 10 certificate',
      phone: '9876543210',
      updatedAt: at(1),
    },
    {
      id: 'rq-102',
      stage: 'new',
      recipientName: 'Fatima Sheikh',
      credential: 'Bonafide letter',
      email: 'fatima@example.in',
      updatedAt: at(5),
    },
    {
      id: 'rq-103',
      stage: 'pending_data',
      recipientName: 'Rahul Verma',
      credential: 'Class 10 certificate',
      phone: '9812345678',
      note: 'Photo missing',
      updatedAt: at(26),
    },
    {
      id: 'rq-104',
      stage: 'pending_data',
      recipientName: 'Meera Nair',
      credential: 'Sports participation',
      email: 'meera@example.in',
      note: 'Date of birth to confirm',
      updatedAt: at(50),
    },
    {
      id: 'rq-105',
      stage: 'ready',
      recipientName: 'Priyanka Tripathi',
      credential: 'Class 10 certificate',
      phone: '9898989898',
      email: 'priyanka@example.in',
      updatedAt: at(3),
    },
    {
      id: 'rq-106',
      stage: 'issued',
      recipientName: 'Venkata Subramanian',
      credential: 'Olympiad merit certificate',
      phone: '9000000001',
      updatedAt: at(80),
    },
  ];
}
