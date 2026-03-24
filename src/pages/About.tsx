import { Container, Typography, Box, Paper } from '@mui/material'

export function About() {
  return (
    <Container maxWidth="md">
      <Paper sx={{ p: 4 }}>
        <Typography variant="h2" gutterBottom>
          About
        </Typography>
        <Typography variant="body1" paragraph>
          This is the about page for doc-upload-site.
        </Typography>
        <Typography variant="body1" paragraph>
          A document upload/download hosting site with multi tenant access, 3 tier permission system (admin, user, reader), including vbersion traacking. hosted in cloudflare adn backed by d1 maybe? i am open to optinos, we are going to stroe files so it should be cheap! Heres the original specs: Document Upload/Download Portal (Outsourced Website) Purpose: Centralized repository for regulatory documents Security: High priority requirement Access Control: Three-tier login system Admin access User access Reader access Primary Objective: Shared workspace enabling manufacturers and vendors to independently manage their documents, including version tracking and updates/uploads as needed Agent Functionality: Database search capability based on document requests, with automated download and report generation for users
        </Typography>
      </Paper>
    </Container>
  )
}