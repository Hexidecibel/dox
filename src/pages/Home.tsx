import { Container, Typography, Box, Button } from '@mui/material'
import { Link as RouterLink } from 'react-router-dom'

export function Home() {
  return (
    <Container maxWidth="lg">
      <Box sx={{ textAlign: 'center', py: 8 }}>
        <Typography variant="h1" gutterBottom>
          Welcome to Dox
        </Typography>
        <Typography variant="h5" color="text.secondary" paragraph>
          A document upload/download hosting site with multi tenant access, 3 tier permission system (admin, user, reader), including vbersion traacking. hosted in cloudflare adn backed by d1 maybe? i am open to optinos, we are going to stroe files so it should be cheap! Heres the original specs: Document Upload/Download Portal (Outsourced Website) Purpose: Centralized repository for regulatory documents Security: High priority requirement Access Control: Three-tier login system Admin access User access Reader access Primary Objective: Shared workspace enabling manufacturers and vendors to independently manage their documents, including version tracking and updates/uploads as needed Agent Functionality: Database search capability based on document requests, with automated download and report generation for users
        </Typography>
        <Box sx={{ mt: 4 }}>
          <Button
            variant="contained"
            size="large"
            component={RouterLink}
            to="/about"
          >
            Learn More
          </Button>
        </Box>
      </Box>
    </Container>
  )
}