import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import Home from '@/app/page'

describe('Home page scaffold', () => {
  it('renders the billing scaffold heading and stack summary', () => {
    render(<Home />)

    expect(
      screen.getByRole('heading', { name: 'Billing Admin scaffold' })
    ).toBeTruthy()
    expect(
      screen.getByText(/next\.js, supabase, vitest, and playwright/i)
    ).toBeTruthy()
  })
})
