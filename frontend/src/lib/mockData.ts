export type JobPosting = {
  id: string
  title: string
  location: string
  jobType: 'Full-time' | 'Part-time' | 'Contract'
  status: 'active' | 'closed'
  applicants: number
  postedAt: string // ISO date string e.g. '2026-03-15'
}

export type Applicant = {
  id: string
  name: string
  jobTitle: string  // the job they applied to (matches a JobPosting title)
  appliedAt: string // ISO date string
  status: 'pending' | 'reviewed' | 'hired'
  phone: string
  skills: string[]
}

export type DashboardStats = {
  activeJobs: number
  totalApplicants: number
  totalViews: number
}

export const mockJobs: JobPosting[] = [
  {
    id: 'job-001',
    title: 'Warehouse Associate',
    location: 'Dallas, TX',
    jobType: 'Full-time',
    status: 'active',
    applicants: 3,
    postedAt: '2026-03-15',
  },
  {
    id: 'job-002',
    title: 'Forklift Operator',
    location: 'Houston, TX',
    jobType: 'Full-time',
    status: 'active',
    applicants: 2,
    postedAt: '2026-03-20',
  },
  {
    id: 'job-003',
    title: 'Construction Laborer',
    location: 'Austin, TX',
    jobType: 'Contract',
    status: 'active',
    applicants: 2,
    postedAt: '2026-03-28',
  },
  {
    id: 'job-004',
    title: 'Delivery Driver',
    location: 'San Antonio, TX',
    jobType: 'Full-time',
    status: 'closed',
    applicants: 1,
    postedAt: '2026-02-10',
  },
  {
    id: 'job-005',
    title: 'General Maintenance Technician',
    location: 'Fort Worth, TX',
    jobType: 'Part-time',
    status: 'active',
    applicants: 0,
    postedAt: '2026-04-01',
  },
]

export const mockApplicants: Applicant[] = [
  {
    id: 'app-001',
    name: 'Carlos Mendoza',
    jobTitle: 'Warehouse Associate',
    appliedAt: '2026-03-17',
    status: 'reviewed',
    phone: '+12145550142',
    skills: ['Inventory Management', 'Pallet Jack', 'Forklift Certified'],
  },
  {
    id: 'app-002',
    name: 'Maria Torres',
    jobTitle: 'Warehouse Associate',
    appliedAt: '2026-03-18',
    status: 'pending',
    phone: '+12145550278',
    skills: ['Order Picking', 'Shipping & Receiving', 'RF Scanner'],
  },
  {
    id: 'app-003',
    name: 'James Okafor',
    jobTitle: 'Warehouse Associate',
    appliedAt: '2026-03-22',
    status: 'hired',
    phone: '+14695550391',
    skills: ['Heavy Lifting', 'Inventory Control', 'Safety Compliance'],
  },
  {
    id: 'app-004',
    name: 'Luis Ramirez',
    jobTitle: 'Forklift Operator',
    appliedAt: '2026-03-21',
    status: 'reviewed',
    phone: '+17135550167',
    skills: ['Forklift Certified', 'OSHA 10', 'Pallet Stacking'],
  },
  {
    id: 'app-005',
    name: 'Angela Brooks',
    jobTitle: 'Forklift Operator',
    appliedAt: '2026-03-25',
    status: 'pending',
    phone: '+17135550284',
    skills: ['Reach Truck', 'Standup Forklift', 'Warehouse Safety'],
  },
  {
    id: 'app-006',
    name: 'Miguel Flores',
    jobTitle: 'Construction Laborer',
    appliedAt: '2026-03-30',
    status: 'pending',
    phone: '+15125550315',
    skills: ['Concrete Work', 'Demolition', 'Hand Tools'],
  },
  {
    id: 'app-007',
    name: 'Darnell Washington',
    jobTitle: 'Construction Laborer',
    appliedAt: '2026-04-02',
    status: 'pending',
    phone: '+15125550449',
    skills: ['Framing', 'Site Cleanup', 'Power Tools', 'OSHA 10'],
  },
  {
    id: 'app-008',
    name: 'Sandra Gutierrez',
    jobTitle: 'Delivery Driver',
    appliedAt: '2026-02-12',
    status: 'hired',
    phone: '+12105550523',
    skills: ['CDL Class B', 'Route Planning', 'Customer Service'],
  },
]

// activeJobs = 4 (job-001, job-002, job-003, job-005 are active)
// totalApplicants = 8 (total entries in mockApplicants)
// totalViews represents page impressions across all job postings
export const mockStats: DashboardStats = {
  activeJobs: 4,
  totalApplicants: 8,
  totalViews: 312,
}
